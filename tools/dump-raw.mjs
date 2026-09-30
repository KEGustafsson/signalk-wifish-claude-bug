#!/usr/bin/env node
// Dump a raw capture written by wifish-probe.mjs --log.
// Record format: [u64 ms][u8 channel 0=discovery 1=data][u32 len][bytes]
// Usage: node dump-raw.mjs raw.bin [--id 0x270104] [--hex]
import fs from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: dump-raw.mjs raw.bin [--id 0xNNNNNN] [--hex]'); process.exit(1); }
const idFilter = rest.includes('--id') ? Number(rest[rest.indexOf('--id') + 1]) : null;
const hex = rest.includes('--hex');

const buf = fs.readFileSync(file);
const counts = new Map();
for (let o = 0; o + 13 <= buf.length;) {
  const ts = Number(buf.readBigUInt64LE(o)), ch = buf[o + 8], len = buf.readUInt32LE(o + 9);
  const msg = buf.subarray(o + 13, o + 13 + len);
  o += 13 + len;
  if (msg.length < 4) continue;
  const id = msg.readUInt32LE(0);
  counts.set(id, (counts.get(id) ?? 0) + 1);
  if (idFilter !== null && id !== idFilter) continue;
  if (idFilter === null && !hex) continue;
  console.log(`${new Date(ts).toISOString()} ch=${ch} id=0x${id.toString(16)} len=${len}`);
  if (hex) console.log(msg.toString('hex').replace(/(.{32})/g, '$1\n'));
}
console.log('\nmessage counts:');
for (const [id, n] of [...counts].sort((a, b) => a[0] - b[0])) console.log(`  0x${id.toString(16).padStart(6, '0')}: ${n}`);
