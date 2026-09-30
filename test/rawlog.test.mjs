import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRecord, readRawLog } from '../lib/rawlog.mjs';

test('encodeRecord / readRawLog round trip', () => {
  const buf = Buffer.concat([
    encodeRecord(0, Buffer.from([1, 2, 3]), 1000),
    encodeRecord(1, Buffer.alloc(0), 2000),
  ]);
  const recs = [...readRawLog(buf)];
  assert.equal(recs.length, 2);
  assert.deepEqual({ ...recs[0], msg: [...recs[0].msg] }, { ts: 1000, channel: 0, msg: [1, 2, 3] });
  assert.equal(recs[1].ts, 2000);
  assert.equal(recs[1].channel, 1);
  assert.equal(recs[1].msg.length, 0);
});

test('readRawLog reports a truncated body instead of yielding a short message', () => {
  const full = encodeRecord(1, Buffer.alloc(68), 5);
  const recs = [...readRawLog(Buffer.concat([encodeRecord(0, Buffer.from([9]), 1), full.subarray(0, 20)]))];
  assert.equal(recs.length, 2);
  assert.deepEqual(recs[1], { truncated: { offset: 14, missing: 61 } });
});

test('readRawLog reports a partial header', () => {
  assert.deepEqual([...readRawLog(Buffer.alloc(5))], [{ truncated: { offset: 0, missing: 8 } }]);
});
