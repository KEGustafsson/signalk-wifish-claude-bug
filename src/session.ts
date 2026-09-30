// Sonar4 session state: decodes datagrams from any transport (UDP device, demo
// device, capture replay) and keeps what the app keeps. Builds settings commands.
// No I/O here; the owner sends what build* returns.

import { EventEmitter } from 'node:events';
import {
  VERSION, MsgId, REQUIRED, messageId, parseHeader, isWellFormed, parseUnit, parseBottom, parseEnv,
  parseError, parseSystemStatus, parsePingResults, parsePingData, parseChannelSettings, parseSystemSettings,
  buildChannelSettings, buildSystemSettings, PingAssembler,
  type Unit, type SystemStatus, type ChannelSettings, type SystemSettings, type ChannelSettingsPatch,
  type SystemSettingsPatch, type ChannelId,
} from './sonar4';

export interface SessionColumn {
  channel: ChannelId;
  configIndex: number;
  seq: number;
  /** Samples cover 0 .. endCm below the transducer (one byte each, 0 = no return). */
  samples: Uint8Array;
  /** Default view window: range start / end in cm below the transducer. */
  startCm: number;
  endCm: number;
}

interface Held<T> { parsed: T; raw: Uint8Array }

export interface SessionEvents {
  unit: [Unit];
  bottom: [number | null];
  temperature: [number | null];
  errorFlags: [number];
  systemStatus: [SystemStatus];
  systemSettings: [SystemSettings];
  channelSettings: [ChannelSettings];
  column: [SessionColumn];
  warn: [string];
}

export class Sonar4Session extends EventEmitter<SessionEvents> {
  readonly seen = new Map<number, number>();
  readonly asm = new PingAssembler();
  unit: Unit | null = null;
  bottomCm: number | null = null;
  waterTempCentiC: number | null = null;
  errorFlags: number | null = null;
  systemStatus: SystemStatus | null = null;
  #system: Held<SystemSettings> | null = null;
  #channels = new Map<number, Held<ChannelSettings>>();
  /** Ping configuration index last seen per channel (0 = sonar, 1 = DownVision). */
  readonly configIndex: [number | null, number | null] = [null, null];
  columns = 0;
  #warned = new Set<string>();

  get system(): SystemSettings | null {
    return this.#system?.parsed ?? null;
  }
  channelSettings(index: number | null): ChannelSettings | null {
    return index === null ? null : this.#channels.get(index)?.parsed ?? null;
  }
  /** All REQUIRED messages seen at least once: keepalive may report "connected". */
  get ready(): boolean {
    return REQUIRED.every((id) => this.seen.has(id));
  }

  /** Forget per-connection state (the app resets its decoders on reconnect). */
  reset(): void {
    this.seen.clear();
    this.#system = null;
    this.#channels.clear();
    this.configIndex[0] = this.configIndex[1] = null;
    this.bottomCm = null;
    this.errorFlags = null;
  }

  #warnOnce(key: string, msg: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.emit('warn', msg);
  }

  /** Feed one datagram. Returns the message id, or null if it was ignored. */
  handle(b: Uint8Array, now = Date.now()): number | null {
    const id = messageId(b);
    if (id === MsgId.UNIT) {
      const u = parseUnit(b);
      if (u && (this.unit?.type !== u.type || this.unit.name !== u.name || this.unit.serial !== u.serial)) {
        this.unit = u;
        this.emit('unit', u);
      }
      return u ? id : null;
    }
    const h = parseHeader(b);
    if (!h) return null;
    const hex = `0x${h.id.toString(16)}`;
    if (h.version !== VERSION) {
      this.#warnOnce(`ver${h.id}`, `${hex} protocol version ${h.version} != ${VERSION}, ignored`);
      return null;
    }
    if (!isWellFormed(b, h)) {
      this.#warnOnce(`len${h.id}`, `${hex} malformed (${b.length} bytes, header says ${h.length}), dropping these`);
      return null;
    }
    this.seen.set(h.id, (this.seen.get(h.id) ?? 0) + 1);

    switch (h.id) {
      case MsgId.BOTTOM: {
        const m = parseBottom(b)!;
        this.bottomCm = m.depthCm;
        this.emit('bottom', m.depthCm);
        break;
      }
      case MsgId.ENV: {
        this.waterTempCentiC = parseEnv(b)!.waterTempCentiC;
        this.emit('temperature', this.waterTempCentiC);
        break;
      }
      case MsgId.ERROR:
        this.errorFlags = parseError(b)!.flags;
        this.emit('errorFlags', this.errorFlags);
        break;
      case MsgId.SYS_STATUS: {
        const s = parseSystemStatus(b);
        if (s) { this.systemStatus = s; this.emit('systemStatus', s); }
        break;
      }
      case MsgId.SYS_SETTINGS: {
        const s = parseSystemSettings(b);
        // Like the app: only a newer seq replaces what we hold (our own echo is not newer).
        if (s && (!this.#system || s.seq > this.#system.parsed.seq)) {
          this.#system = { parsed: s, raw: Uint8Array.from(b) };
          this.emit('systemSettings', s);
        }
        break;
      }
      case MsgId.CHAN_SETTINGS: {
        const s = parseChannelSettings(b);
        if (!s) { this.#warnOnce('chanset', 'channel settings with bad size or index, ignored'); break; }
        const held = this.#channels.get(s.index);
        if (!held || s.seq > held.parsed.seq) {
          this.#channels.set(s.index, { parsed: s, raw: Uint8Array.from(b) });
          this.emit('channelSettings', s);
        }
        break;
      }
      case MsgId.PING_RESULTS:
        this.asm.addResults(parsePingResults(b));
        break;
      case MsgId.PING_DATA: {
        const col = this.asm.push(parsePingData(b), now);
        if (col) this.#column(col.results, col.setting, col.seq, col.samples);
        break;
      }
    }
    return h.id;
  }

  #column(r: ReturnType<typeof parsePingResults>, configIndex: number, seq: number, samples: Uint8Array): void {
    if (!r || (r.channel !== 0 && r.channel !== 1)) return; // can't tell which trace it belongs to
    const channel = r.channel as ChannelId;
    const cs = this.channelSettings(configIndex);
    if (cs && !cs.enabled) return; // the app skips configurations it holds as disabled
    this.configIndex[channel] = configIndex;
    const auto = cs ? cs.rangeAuto : true;
    let startCm = auto ? r.rangeStartCm : cs!.rangeShallowCm;
    let endCm = auto ? r.rangeEndCm : cs!.rangeDeepCm;
    if (!(endCm > 0)) { endCm = r.rangeEndCm > 0 ? r.rangeEndCm : 1000; }
    if (!(startCm >= 0 && startCm < endCm)) startCm = 0;
    this.columns++;
    this.emit('column', { channel, configIndex, seq, samples, startCm, endCm });
  }

  /**
   * Channel settings datagrams for a UI change on `channel`. Range fields apply
   * to both channels, like the app's Range tab; the rest only to `channel`.
   */
  buildChannelCommands(channel: ChannelId, patch: ChannelSettingsPatch): Uint8Array[] {
    const { rangeAuto, rangeShallowCm, rangeDeepCm, ...own } = patch;
    const range: ChannelSettingsPatch = {};
    if (rangeAuto !== undefined) range.rangeAuto = rangeAuto;
    if (rangeShallowCm !== undefined) range.rangeShallowCm = rangeShallowCm;
    if (rangeDeepCm !== undefined) range.rangeDeepCm = rangeDeepCm;
    const out: Uint8Array[] = [];
    for (const ch of [0, 1] as const) {
      const p: ChannelSettingsPatch = { ...range, ...(ch === channel ? own : {}) };
      if (!Object.keys(p).length) continue;
      const idx = this.configIndex[ch];
      const held = idx === null ? undefined : this.#channels.get(idx);
      if (!held) continue;
      const seq = held.parsed.seq + 1;
      const raw = buildChannelSettings(held.raw, p, seq);
      this.#channels.set(idx!, { parsed: parseChannelSettings(raw)!, raw });
      this.emit('channelSettings', this.#channels.get(idx!)!.parsed);
      out.push(raw);
    }
    return out;
  }

  /** System settings datagram for a change, or null before the device sent its settings. */
  buildSystemCommand(patch: SystemSettingsPatch): Uint8Array | null {
    if (!this.#system) return null;
    const raw = buildSystemSettings(this.#system.raw, patch, this.#system.parsed.seq + 1);
    this.#system = { parsed: parseSystemSettings(raw)!, raw };
    this.emit('systemSettings', this.#system.parsed);
    return raw;
  }
}
