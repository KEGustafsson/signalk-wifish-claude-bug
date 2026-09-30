import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centiCToK, cmToM, toDelta, Throttle, PATH } from '../lib/signalk.mjs';

test('centiCToK has no float noise across -40..+60 degC', () => {
  for (let c = -4000; c <= 6000; c++) {
    const k = centiCToK(c);
    assert.equal(k, Number(k.toFixed(2)), `c=${c} -> ${k}`);
  }
  assert.equal(centiCToK(1234), 285.49); // 12.34 + 273.15 === 285.48999999999995
});

test('cmToM', () => assert.equal(cmToM(1234), 12.34));

test('toDelta is a well-formed v1 delta, null allowed', () => {
  assert.deepEqual(toDelta([{ path: PATH.depth, value: null }]),
    { context: 'vessels.self', updates: [{ values: [{ path: 'environment.depth.belowTransducer', value: null }] }] });
});

test('Throttle: change, heartbeat, rate limit, null edge', () => {
  const t = new Throttle({ minIntervalMs: 200, heartbeatMs: 10_000 });
  assert.ok(t.shouldEmit('p', 1, 0));          // first value
  assert.ok(!t.shouldEmit('p', 2, 100));       // changed, but within 200 ms
  assert.ok(t.shouldEmit('p', 2, 300));        // changed, rate ok
  assert.ok(!t.shouldEmit('p', 2, 5_000));     // unchanged, no heartbeat yet
  assert.ok(t.shouldEmit('p', 2, 10_300));     // heartbeat
  assert.ok(t.shouldEmit('p', null, 10_301));  // lock lost: always immediate
  assert.ok(!t.shouldEmit('p', null, 10_400));
  assert.ok(t.shouldEmit('p', 3, 10_401));     // lock regained: immediate
});
