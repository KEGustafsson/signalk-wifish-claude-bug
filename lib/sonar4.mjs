// @ts-check
// Pure "Sonar4" codec (docs/PROTOCOL.md). No I/O, no logging, no module state.
// Every parse* takes a Uint8Array (Buffer ok) and returns a plain object, or
// null when the datagram is too short / not the expected message.

export const VERSION = 116;
export const DISCOVERY = { group: '224.0.0.1', port: 5800 };
export const SERVICE_SONAR = 39;
export const MAX_COLUMN = 1024;
export const HEADER_LEN = 16;

export const MsgId = Object.freeze({
  ANNOUNCE: 0, UNIT: 1,
  KEEPALIVE: 0x270100, PING_DATA: 0x270101, CHAN_SETTINGS: 0x270102,
  SYS_STATUS: 0x270103, ENV: 0x270104, SYS_SETTINGS: 0x270106,
  BOTTOM: 0x270108, PING_RESULTS: 0x27010b, ERROR: 0x27010d,
});
/** Messages that must be seen before keepalive byte 16 = 1 (§3.4). */
export const REQUIRED = Object.freeze([MsgId.ENV, MsgId.ERROR, MsgId.SYS_STATUS, MsgId.SYS_SETTINGS, MsgId.CHAN_SETTINGS]);

/** Minimum datagram length each parser needs (the fields it reads). */
const MIN = { ANNOUNCE: 36, UNIT: 52, BOTTOM: 22, ENV: 30, ERROR: 20, PING_RESULTS: 112, PING_DATA: 37 };

/** Minimum message length the app accepts per id (PROTOCOL.md §5). Shorter = malformed. */
export const MIN_LEN = Object.freeze({
  [MsgId.PING_DATA]: 37, [MsgId.CHAN_SETTINGS]: 94, [MsgId.SYS_STATUS]: 1063, [MsgId.ENV]: 68,
  [MsgId.SYS_SETTINGS]: 562, [MsgId.BOTTOM]: 22, [MsgId.PING_RESULTS]: 130, [MsgId.ERROR]: 20,
});

/** True when `b` is as long as both its header length field and the §5 minimum for its id. */
export function isWellFormed(b, h) {
  return h.length >= HEADER_LEN && h.length <= b.length && b.length >= (MIN_LEN[h.id] ?? HEADER_LEN);
}

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const ip4 = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;

/** Message id at offset 0, or null if < 4 bytes. */
export function messageId(b) {
  return b.length >= 4 ? dv(b).getUint32(0, true) : null;
}

/** @returns {{id:number,length:number,version:number,seq:number}|null} for 0x2701xx only */
export function parseHeader(b) {
  if (b.length < HEADER_LEN) return null;
  const v = dv(b);
  const id = v.getUint32(0, true);
  if (id >>> 8 !== 0x2701) return null;
  return { id, length: v.getUint32(4, true), version: v.getUint32(8, true), seq: v.getUint32(12, true) };
}

/** Discovery msg 0. */
export function parseAnnounce(b) {
  if (b.length < MIN.ANNOUNCE || messageId(b) !== MsgId.ANNOUNCE) return null;
  const v = dv(b);
  return {
    service: v.getUint32(8, true),
    group: ip4(b, 20), port: v.getUint32(24, true),
    device: ip4(b, 28), ctrlPort: v.getUint32(32, true),
  };
}

const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;

/**
 * Checks an announced sonar service before sockets are opened with it.
 * @param {ReturnType<typeof parseAnnounce>} s
 * @param {string} [sender] source address of the announcement; must match the announced device IP
 * @returns {string|null} reason it is unusable, or null if ok
 */
export function checkService(s, sender) {
  if (!s) return 'malformed';
  const first = Number(s.group.split('.')[0]);
  if (first < 224 || first > 239) return `data group ${s.group} is not multicast`;
  if (!validPort(s.port)) return `bad data port ${s.port}`;
  if (!validPort(s.ctrlPort)) return `bad control port ${s.ctrlPort}`;
  if (sender !== undefined && sender !== s.device) return `device ${s.device} != sender ${sender}`;
  return null;
}

/** Discovery msg 1. */
export function parseUnit(b) {
  if (b.length < MIN.UNIT || messageId(b) !== MsgId.UNIT) return null;
  const v = dv(b);
  const raw = new TextDecoder('latin1').decode(b.subarray(20, 52));
  return { type: v.getUint32(4, true), serial: v.getUint32(8, true).toString(16), name: raw.replace(/\0.*$/s, '') };
}

/** 0x270108. depthCm null = no bottom lock (INT32_MIN). */
export function parseBottom(b) {
  if (b.length < MIN.BOTTOM || messageId(b) !== MsgId.BOTTOM) return null;
  const d = dv(b).getInt32(17, true);
  return { depthCm: d === -0x80000000 ? null : d, quality: b[16], channel: b[21] };
}

/** 0x270104. waterTempCentiC null = invalid (INT16_MIN). Kept integer; convert at the edge. */
export function parseEnv(b) {
  if (b.length < MIN.ENV || messageId(b) !== MsgId.ENV) return null;
  const t = dv(b).getInt16(28, true);
  return { waterTempCentiC: t === -0x8000 ? null : t };
}

/** 0x27010D. */
export function parseError(b) {
  if (b.length < MIN.ERROR || messageId(b) !== MsgId.ERROR) return null;
  return { flags: dv(b).getUint32(16, true) };
}

/** 0x27010B. */
export function parsePingResults(b) {
  if (b.length < MIN.PING_RESULTS || messageId(b) !== MsgId.PING_RESULTS) return null;
  const v = dv(b);
  return { seq: b[16], channel: b[95], rangeStartCm: v.getInt32(104, true), rangeEndCm: v.getInt32(108, true) };
}

/** 0x270101 segment. `samples` is a view into b (copy before b is reused). */
export function parsePingData(b) {
  if (b.length < MIN.PING_DATA || messageId(b) !== MsgId.PING_DATA) return null;
  const v = dv(b);
  const len = Math.min(v.getUint32(4, true), b.length);
  if (len < MIN.PING_DATA) return null;
  return {
    error: v.getUint32(16, true), offset: v.getUint32(20, true), total: v.getUint32(24, true),
    dataType: b[32], seq: b[33], segment: b[34], count: b[35], setting: b[36],
    samples: b.subarray(37, len),
  };
}

/** 37-byte keepalive (§4). */
export function buildKeepalive({ connected = false, nowMs = Date.now() } = {}) {
  const k = new Uint8Array(37);
  const v = dv(k);
  v.setUint32(0, MsgId.KEEPALIVE, true); v.setUint32(4, 37, true); v.setUint32(8, VERSION, true);
  v.setUint32(12, 0xdeadbeef, true);
  v.setUint8(16, connected ? 1 : 0);
  v.setBigUint64(17, BigInt(Math.floor(nowMs / 1000)), true);
  v.setBigInt64(25, -1n, true);
  v.setInt32(33, -0x80000000, true);
  return k;
}

/**
 * Reassembles 0x270101 segments into columns, keyed by ping seq (u8).
 * Faithful to the app: a column starts at segment 0, any gap drops it,
 * it completes at segment == count-1. Adds bounds checks so a malformed
 * segment is dropped instead of throwing or allocating 4 GB, and expires
 * partial columns so a wrapped seq can't be glued onto a stale one.
 * `filled` in the result is the number of sample bytes received (== samples.length
 * when the segments covered the whole column).
 */
export class PingAssembler {
  /** @type {Map<number,{buf:Uint8Array,next:number,filled:number,t:number,dataType:number,setting:number}>} */
  #pings = new Map();
  /** @type {Map<number,ReturnType<typeof parsePingResults>>} */
  #results = new Map();
  dropped = 0;

  constructor({ staleMs = 1000 } = {}) {
    this.staleMs = staleMs;
  }

  /** Remember per-ping metadata (0x27010B) for pairing; keeps the last 32. */
  addResults(r) {
    if (!r) return;
    this.#results.delete(r.seq);
    this.#results.set(r.seq, r);
    if (this.#results.size > 32) this.#results.delete(this.#results.keys().next().value);
  }

  /**
   * @param {ReturnType<typeof parsePingData>} s
   * @param {number} [now] ms timestamp
   * @returns {{seq:number,dataType:number,setting:number,samples:Uint8Array,filled:number,results:any}|null}
   */
  push(s, now = Date.now()) {
    if (!s) return null;
    if (s.error !== 0 || s.count === 0 || s.segment >= s.count
        || s.total === 0 || s.total > MAX_COLUMN || s.offset + s.samples.length > s.total) {
      return this.#drop(s.seq);
    }
    let p = this.#pings.get(s.seq);
    if (s.segment === 0) {
      p = { buf: new Uint8Array(s.total), next: 0, filled: 0, t: now, dataType: s.dataType, setting: s.setting };
      this.#pings.set(s.seq, p);
    }
    if (!p || p.next !== s.segment || p.buf.length !== s.total || now - p.t > this.staleMs) return this.#drop(s.seq);
    p.buf.set(s.samples, s.offset);
    p.filled += s.samples.length;
    p.next++;
    if (s.segment !== s.count - 1) return null;
    this.#pings.delete(s.seq);
    return {
      seq: s.seq, dataType: p.dataType, setting: p.setting, samples: p.buf, filled: p.filled,
      results: this.#results.get(s.seq) ?? null,
    };
  }

  #drop(seq) {
    if (this.#pings.delete(seq)) this.dropped++;
    return null;
  }
}
