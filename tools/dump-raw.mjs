#!/usr/bin/env node
// Dump a raw capture written by wifish-probe.mjs --log (format: lib/rawlog.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readRawLog } from '../lib/rawlog.mjs';
import { messageId } from '../lib/sonar4.mjs';

const USAGE = `Usage: dump-raw <raw.bin> [--id 0xNNNNNN] [--hex]
  (no flags)   per-id message counts only
  --id <id>    list messages with this id (decimal or 0x hex)
  --hex        hex dump (all messages, or only --id ones)`;

let file, idFilter = null, hex;
try {
  const { values, positionals } = parseArgs({
    strict: true, allowPositionals: true,
    options: { id: { type: 'string' }, hex: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) { console.log(USAGE); process.exit(0); }
  if (positionals.length !== 1) throw new Error('expected exactly one capture file');
  if (values.id !== undefined) {
    idFilter = Number(values.id);
    if (!Number.isInteger(idFilter) || idFilter < 0) throw new Error(`--id: not a number: ${values.id}`);
  }
  [file] = positionals;
  hex = values.hex;
} catch (e) {
  console.error(`${e.message}\n\n${USAGE}`);
  process.exit(2);
}

// npm run executes from the package root; resolve against where the user ran it.
let buf;
try {
  buf = fs.readFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), file));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const counts = new Map();
for (const r of readRawLog(buf)) {
  if (r.truncated) {
    console.error(`truncated record at byte ${r.truncated.offset} (${r.truncated.missing} bytes missing); stopping`);
    process.exitCode = 1;
    break;
  }
  const id = messageId(r.msg);
  if (id === null) continue;
  counts.set(id, (counts.get(id) ?? 0) + 1);
  if (idFilter !== null ? id !== idFilter : !hex) continue;
  console.log(`${new Date(r.ts).toISOString()} ch=${r.channel} id=0x${id.toString(16)} len=${r.msg.length}`);
  if (hex) console.log(r.msg.toString('hex').replace(/(.{32})/g, '$1\n'));
}
console.log('\nmessage counts:');
for (const [id, n] of [...counts].sort((a, b) => a[0] - b[0])) console.log(`  0x${id.toString(16).padStart(6, '0')}: ${n}`);
