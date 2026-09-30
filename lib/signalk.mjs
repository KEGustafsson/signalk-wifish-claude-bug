// @ts-check
// Sonar4 values -> Signal K v1 deltas. Pure; the transport (UDP, app.handleMessage) is the caller's.

/** Integer arithmetic first, one division last: avoids 285.48999999999995-style output. */
export const cmToM = (cm) => cm / 100;
export const centiCToK = (c) => (c + 27315) / 100;

export const PATH = Object.freeze({
  depth: 'environment.depth.belowTransducer',
  waterTemp: 'environment.water.temperature',
});

/**
 * One delta, several values. `null` values are legal Signal K and mean "no data"
 * (e.g. bottom lock lost) so consumers stop showing a stale depth.
 * $source/timestamp are left out on purpose: the server sets $source to the
 * data-connection / plugin id and stamps receive time.
 */
export function toDelta(values) {
  return { context: 'vessels.self', updates: [{ values }] };
}

/**
 * Emits a path when its value changed, or when `heartbeatMs` elapsed, but never
 * faster than `minIntervalMs`. A change to/from null always passes through.
 */
export class Throttle {
  #last = new Map();
  constructor({ minIntervalMs = 0, heartbeatMs = 10_000 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.heartbeatMs = heartbeatMs;
  }
  /** @param {string} path @param {number|null} value @param {number} now */
  shouldEmit(path, value, now) {
    const l = this.#last.get(path);
    const nullEdge = l && (l.value === null) !== (value === null);
    const due = !l || nullEdge
      || (now - l.t >= this.minIntervalMs && (value !== l.value || now - l.t >= this.heartbeatMs));
    if (due) this.#last.set(path, { value, t: now });
    return due;
  }
}
