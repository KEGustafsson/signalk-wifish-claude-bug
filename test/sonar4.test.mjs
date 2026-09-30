import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MsgId, VERSION, parseHeader, isWellFormed, parseAnnounce, checkService, parseUnit, parseBottom, parseEnv,
  parsePingResults, parsePingData, buildKeepalive, PingAssembler,
} from '../lib/sonar4.mjs';

// Build a Sonar4 message: 16-byte header + caller-filled payload.
function msg(id, len, fill = () => {}) {
  const b = Buffer.alloc(len);
  b.writeUInt32LE(id, 0); b.writeUInt32LE(len, 4); b.writeUInt32LE(VERSION, 8); b.writeUInt32LE(7, 12);
  fill(b);
  return b;
}

function segment({ seq, seg, count, total, offset, data, error = 0 }) {
  return msg(MsgId.PING_DATA, 37 + data.length, (b) => {
    b.writeUInt32LE(error, 16); b.writeUInt32LE(offset, 20); b.writeUInt32LE(total, 24);
    b[32] = 2; b[33] = seq; b[34] = seg; b[35] = count; b[36] = 5;
    Buffer.from(data).copy(b, 37);
  });
}

test('parseHeader accepts 0x2701xx and rejects others / short input', () => {
  assert.deepEqual(parseHeader(msg(MsgId.ENV, 68)), { id: MsgId.ENV, length: 68, version: 116, seq: 7 });
  assert.equal(parseHeader(Buffer.alloc(15)), null);
  assert.equal(parseHeader(msg(0x123456, 16)), null);
});

test('parseAnnounce decodes sonar service (§2)', () => {
  const b = Buffer.alloc(36);
  b.writeUInt32LE(39, 8); b.set([239, 1, 2, 3], 20); b.writeUInt32LE(5801, 24);
  b.set([192, 168, 1, 1], 28); b.writeUInt32LE(5802, 32);
  assert.deepEqual(parseAnnounce(b),
    { service: 39, group: '239.1.2.3', port: 5801, device: '192.168.1.1', ctrlPort: 5802 });
  assert.equal(parseAnnounce(b.subarray(0, 35)), null);
});

test('checkService rejects unusable announcements', () => {
  const s = { service: 39, group: '239.1.2.3', port: 5801, device: '192.168.1.1', ctrlPort: 5802 };
  assert.equal(checkService(s, '192.168.1.1'), null);
  assert.equal(checkService(s), null);
  assert.match(checkService({ ...s, group: '10.0.0.1' }), /not multicast/);
  assert.match(checkService({ ...s, port: 70000 }), /data port/);
  assert.match(checkService({ ...s, ctrlPort: 0 }), /control port/);
  assert.match(checkService(s, '192.168.1.66'), /sender/);
  assert.equal(checkService(null), 'malformed');
});

test('isWellFormed enforces §5 minimum and header length', () => {
  const env = msg(MsgId.ENV, 68);
  assert.ok(isWellFormed(env, parseHeader(env)));
  const short = msg(MsgId.ENV, 29);
  assert.ok(!isWellFormed(short, parseHeader(short)));          // below §5 minimum (68)
  const cut = msg(MsgId.ENV, 80).subarray(0, 70);                // header says 80, got 70
  assert.ok(!isWellFormed(cut, parseHeader(cut)));
  const unknown = msg(0x270109, 16);
  assert.ok(isWellFormed(unknown, parseHeader(unknown)));
});

test('parseUnit strips NUL padding', () => {
  const b = Buffer.alloc(52);
  b.writeUInt32LE(1, 0); b.writeUInt32LE(63, 4); b.writeUInt32LE(0xabc123, 8); b.write('Wi-Fish', 20, 'latin1');
  assert.deepEqual(parseUnit(b), { type: 63, serial: 'abc123', name: 'Wi-Fish' });
});

test('parseBottom: depth in cm, INT32_MIN = no lock, short = null', () => {
  const ok = msg(MsgId.BOTTOM, 22, (b) => { b[16] = 3; b.writeInt32LE(1234, 17); b[21] = 1; });
  assert.deepEqual(parseBottom(ok), { depthCm: 1234, quality: 3, channel: 1 });
  const lost = msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(-0x80000000, 17));
  assert.equal(parseBottom(lost).depthCm, null);
  assert.equal(parseBottom(ok.subarray(0, 18)), null); // crashed the probe before
});

test('parseEnv: centi-degC, INT16_MIN = invalid', () => {
  assert.equal(parseEnv(msg(MsgId.ENV, 68, (b) => b.writeInt16LE(-150, 28))).waterTempCentiC, -150);
  assert.equal(parseEnv(msg(MsgId.ENV, 68, (b) => b.writeInt16LE(-0x8000, 28))).waterTempCentiC, null);
  assert.equal(parseEnv(msg(MsgId.ENV, 29)), null);
});

test('parsePingResults needs 112 bytes', () => {
  const b = msg(MsgId.PING_RESULTS, 130, (x) => { x[16] = 9; x[95] = 1; x.writeInt32LE(0, 104); x.writeInt32LE(1500, 108); });
  assert.deepEqual(parsePingResults(b), { seq: 9, channel: 1, rangeStartCm: 0, rangeEndCm: 1500 });
  assert.equal(parsePingResults(b.subarray(0, 111)), null);
});

test('buildKeepalive matches §4 layout', () => {
  const k = Buffer.from(buildKeepalive({ connected: true, nowMs: 1_700_000_000_999 }));
  assert.equal(k.length, 37);
  assert.equal(k.readUInt32LE(0), 0x270100);
  assert.equal(k.readUInt32LE(4), 37);
  assert.equal(k.readUInt32LE(8), 116);
  assert.equal(k.readUInt32LE(12), 0xdeadbeef);
  assert.equal(k[16], 1);
  assert.equal(k.readBigUInt64LE(17), 1_700_000_000n);
  assert.equal(k.readBigInt64LE(25), -1n);
  assert.equal(k.readInt32LE(33), -0x80000000);
});

test('PingAssembler reassembles in-order segments and pairs results', () => {
  const a = new PingAssembler();
  a.addResults({ seq: 4, channel: 0, rangeStartCm: 0, rangeEndCm: 600 });
  assert.equal(a.push(parsePingData(segment({ seq: 4, seg: 0, count: 2, total: 4, offset: 0, data: [1, 2] }))), null);
  const col = a.push(parsePingData(segment({ seq: 4, seg: 1, count: 2, total: 4, offset: 2, data: [3, 4] })));
  assert.deepEqual([...col.samples], [1, 2, 3, 4]);
  assert.equal(col.results.rangeEndCm, 600);
  assert.equal(col.dataType, 2);
  assert.equal(col.setting, 5);
});

test('PingAssembler drops a ping on a gap, and interleaved seqs are independent', () => {
  const a = new PingAssembler();
  a.push(parsePingData(segment({ seq: 1, seg: 0, count: 3, total: 6, offset: 0, data: [1, 1] })));
  a.push(parsePingData(segment({ seq: 2, seg: 0, count: 1, total: 2, offset: 0, data: [9, 9] })));
  assert.equal(a.push(parsePingData(segment({ seq: 1, seg: 2, count: 3, total: 6, offset: 4, data: [3, 3] }))), null);
  assert.equal(a.dropped, 1);
});

test('PingAssembler rejects malformed segments without throwing or huge allocs', () => {
  const a = new PingAssembler();
  const bad = [
    segment({ seq: 1, seg: 0, count: 1, total: 0xffffffff, offset: 0, data: [1] }), // 4 GB alloc before
    segment({ seq: 1, seg: 0, count: 1, total: 4, offset: 3, data: [1, 2] }),      // overruns column
    segment({ seq: 1, seg: 1, count: 1, total: 4, offset: 0, data: [1] }),         // seg >= count
    segment({ seq: 1, seg: 0, count: 1, total: 4, offset: 0, data: [1], error: 1 }),
  ];
  for (const b of bad) assert.equal(a.push(parsePingData(b)), null);
  assert.equal(a.push(parsePingData(Buffer.alloc(36))), null);
});

test('PingAssembler expires a stale partial column (seq wrap)', () => {
  const a = new PingAssembler({ staleMs: 1000 });
  a.push(parsePingData(segment({ seq: 3, seg: 0, count: 2, total: 4, offset: 0, data: [1, 1] })), 0);
  assert.equal(a.push(parsePingData(segment({ seq: 3, seg: 1, count: 2, total: 4, offset: 2, data: [2, 2] })), 5000), null);
  assert.equal(a.dropped, 1);
});

test('PingAssembler reports how many bytes were filled', () => {
  const a = new PingAssembler();
  a.push(parsePingData(segment({ seq: 6, seg: 0, count: 2, total: 8, offset: 0, data: [1, 2] })));
  const col = a.push(parsePingData(segment({ seq: 6, seg: 1, count: 2, total: 8, offset: 6, data: [7, 8] })));
  assert.equal(col.samples.length, 8);
  assert.equal(col.filled, 4);
});
