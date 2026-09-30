// Ties a transport to a Sonar4 session and fans the result out: Signal K deltas,
// web-app state and echogram columns (with a history backlog for new viewers).

import { EventEmitter } from 'node:events';
import { Sonar4Session, type SessionColumn } from './session';
import { UNIT_TYPES, UNIT_WIFISH, ERROR_LOW_VOLTAGE, type ChannelSettings, type ChannelId } from './sonar4';
import { PATH, centiCToK, depthValues, toDelta, Throttle, type Delta, type PathValue } from './signalk';
import type { LinkState, Transport } from './transport';
import {
  CHANNELS, type ChannelName, type ChannelPatch, type ChannelSettingsView, type ColumnMessage, type SystemPatch,
  type WifishState,
} from './shared/api';

export interface EngineOptions {
  /** Columns kept per channel for viewers that connect later. */
  historyColumns?: number;
  emitDepth?: boolean;
  emitTemperature?: boolean;
  /** Receives Signal K deltas. */
  onDelta?: (d: Delta) => void;
  log?: (msg: string) => void;
}

export interface EngineEvents {
  state: [WifishState];
  column: [ColumnMessage];
}

const NAMES: readonly ChannelName[] = CHANNELS;
const mono = () => globalThis.performance.now();

function view(s: ChannelSettings | null): ChannelSettingsView | null {
  if (!s) return null;
  const { index: configIndex, name, rangeAuto, rangeShallowCm, rangeDeepCm, gainAuto, gain, contrastAuto, contrast, noiseFilterAuto, noiseFilter } = s;
  return { configIndex, name, rangeAuto, rangeShallowCm, rangeDeepCm, gainAuto, gain, contrastAuto, contrast, noiseFilterAuto, noiseFilter };
}

export class Engine extends EventEmitter<EngineEvents> {
  readonly session = new Sonar4Session();
  readonly transport: Transport;
  #opts: Required<Omit<EngineOptions, 'onDelta' | 'log'>> & Pick<EngineOptions, 'onDelta' | 'log'>;
  #link: LinkState = 'offline';
  #message = 'Starting';
  #history: Record<ChannelName, ColumnMessage[]> = { sonar: [], downvision: [] };
  #n: Record<ChannelName, number> = { sonar: 0, downvision: 0 };
  #throttles = {
    depth: new Throttle({ minIntervalMs: 200, heartbeatMs: 5000 }),
    temp: new Throttle({ minIntervalMs: 1000, heartbeatMs: 10_000 }),
  };
  #stateTimer: NodeJS.Timeout | null = null;
  #watchdog: NodeJS.Timeout | null = null;
  #lastData: number | null = null;
  #stale = false;
  #running = false;

  constructor(transport: Transport, opts: EngineOptions = {}) {
    super();
    this.setMaxListeners(0);
    this.transport = transport;
    this.#opts = {
      historyColumns: Math.max(0, Math.min(20_000, opts.historyColumns ?? 1500)),
      emitDepth: opts.emitDepth ?? true,
      emitTemperature: opts.emitTemperature ?? true,
      onDelta: opts.onDelta,
      log: opts.log,
    };
    const s = this.session;
    transport.on('datagram', (b) => {
      try {
        const id = s.handle(b);
        if (id !== null && id >>> 8 === 0x2701) this.#lastData = mono();
      } catch (e) {
        this.#opts.log?.(`decode error: ${(e as Error).message}`);
      }
    });
    transport.on('link', (state, msg) => {
      this.#link = state;
      this.#message = msg;
      if (state === 'searching' || state === 'offline') s.reset();
      this.#stateChanged(true);
    });
    s.on('warn', (m) => this.#opts.log?.(m));
    s.on('unit', () => this.#stateChanged());
    s.on('bottom', (cm) => { this.#depth(cm); this.#stateChanged(); });
    s.on('temperature', (c) => { this.#temperature(c); this.#stateChanged(); });
    s.on('errorFlags', () => this.#stateChanged());
    s.on('systemStatus', () => this.#stateChanged());
    s.on('systemSettings', () => { if (s.bottomCm !== null) this.#depth(s.bottomCm, true); this.#stateChanged(true); });
    s.on('channelSettings', () => this.#stateChanged(true));
    s.on('column', (c) => this.#column(c));
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#watchdog = setInterval(() => this.#checkStale(), 1000);
    this.transport.start();
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#watchdog) clearInterval(this.#watchdog);
    if (this.#stateTimer) clearTimeout(this.#stateTimer);
    this.#watchdog = this.#stateTimer = null;
    this.transport.stop();
    this.transport.removeAllListeners();
    this.session.removeAllListeners();
    this.removeAllListeners();
  }

  get link(): LinkState { return this.#link; }
  get message(): string { return this.#message; }

  history(ch: ChannelName): readonly ColumnMessage[] {
    return this.#history[ch];
  }

  state(): WifishState {
    const s = this.session;
    const u = s.unit;
    const sys = s.system;
    const st = s.systemStatus;
    return {
      source: this.transport.kind,
      link: this.#link,
      message: this.#message,
      canControl: this.transport.canSend && this.#link !== 'offline',
      unit: u ? { type: u.type, model: UNIT_TYPES[u.type] ?? `Unit ${u.type}`, name: u.name, serial: u.serial, wifish: u.type === UNIT_WIFISH } : null,
      softwareVersion: st ? `${st.swMajor}.${st.swMinor}` : null,
      depthCm: s.bottomCm,
      waterTempCentiC: s.waterTempCentiC,
      lowVoltage: s.errorFlags !== null && (s.errorFlags & ERROR_LOW_VOLTAGE) !== 0,
      system: sys ? { transducerOffsetCm: sys.transducerOffsetCm, depthUnit: sys.depthUnit, simulator: sys.simulator } : null,
      channels: {
        sonar: view(s.channelSettings(s.configIndex[0])),
        downvision: view(s.channelSettings(s.configIndex[1])),
      },
      active: { sonar: this.#n.sonar > 0, downvision: this.#n.downvision > 0 },
    };
  }

  /** Apply a settings change from the UI. Returns an error message, or null when sent. */
  setChannel(ch: ChannelName, patch: ChannelPatch): string | null {
    if (!this.transport.canSend) return 'Sonar settings cannot be changed in this mode';
    const code: ChannelId = ch === 'sonar' ? 0 : 1;
    if (this.session.configIndex[code] === null) return `No ${ch} data yet`;
    const msgs = this.session.buildChannelCommands(code, patch);
    if (!msgs.length) return 'Channel settings not received from the sonar yet';
    for (const m of msgs) this.transport.send(m);
    return null;
  }

  setSystem(patch: SystemPatch): string | null {
    if (!this.transport.canSend) return 'Sonar settings cannot be changed in this mode';
    const m = this.session.buildSystemCommand(patch);
    if (!m) return 'System settings not received from the sonar yet';
    this.transport.send(m);
    return null;
  }

  // ------------------------------------------------------------------ internals

  #stateChanged(now = false): void {
    if (now) {
      if (this.#stateTimer) clearTimeout(this.#stateTimer);
      this.#stateTimer = null;
      this.emit('state', this.state());
      return;
    }
    if (this.#stateTimer) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = null;
      this.emit('state', this.state());
    }, 250);
  }

  #emitSk(values: PathValue[]): void {
    if (values.length) this.#opts.onDelta?.(toDelta(values));
  }

  #depth(cm: number | null, force = false): void {
    if (!this.#opts.emitDepth) return;
    const offset = this.session.system?.transducerOffsetCm ?? 0;
    const values = depthValues(cm, offset);
    if (force) this.#throttles.depth.reset();
    const now = mono();
    // Each path goes through the throttle; one delta carries all that are due.
    this.#emitSk(values.filter((v) => this.#throttles.depth.shouldEmit(v.path, v.value, now)));
  }

  #temperature(c: number | null): void {
    if (!this.#opts.emitTemperature) return;
    const value = c === null ? null : centiCToK(c);
    if (this.#throttles.temp.shouldEmit(PATH.waterTemp, value, mono())) this.#emitSk([{ path: PATH.waterTemp, value }]);
  }

  #checkStale(): void {
    const quiet = this.#lastData !== null && mono() - this.#lastData > 5000;
    if (quiet && !this.#stale) {
      this.session.bottomCm = null;
      this.#depth(null, true);
      this.#stateChanged(true);
    }
    this.#stale = quiet;
  }

  #column(c: SessionColumn): void {
    const ch = NAMES[c.channel];
    const offset = this.session.system?.transducerOffsetCm ?? 0;
    const bottom = this.session.bottomCm;
    const msg: ColumnMessage = {
      ch,
      n: ++this.#n[ch],
      t: Date.now(),
      startCm: c.startCm,
      endCm: c.endCm,
      bottomCm: bottom === null ? null : bottom - offset,
      waterTempCentiC: this.session.waterTempCentiC,
      data: Buffer.from(c.samples.buffer, c.samples.byteOffset, c.samples.byteLength).toString('base64'),
    };
    const h = this.#history[ch];
    h.push(msg);
    if (h.length > this.#opts.historyColumns) h.splice(0, h.length - this.#opts.historyColumns);
    if (this.#n[ch] === 1) this.#stateChanged(true);
    this.emit('column', msg);
  }
}
