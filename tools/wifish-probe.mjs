#!/usr/bin/env node
// Wi-Fish "Sonar4" probe — discovery, keepalive, depth/temp decode, raw logging.
// Usage: node wifish-probe.mjs [--iface 192.168.x.y] [--log raw.bin] [--sk host:port] [--no-keepalive]
// Spec: docs/PROTOCOL.md. No dependencies.

import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const NO_KEEPALIVE = args.includes('--no-keepalive');

const DISCOVERY_GROUP = '224.0.0.1';
const DISCOVERY_PORT = 5800;
const VERSION = 116;

const ID = {
  ANNOUNCE: 0, UNIT: 1,
  KEEPALIVE: 0x270100, PING_DATA: 0x270101, CHAN_SETTINGS: 0x270102,
  SYS_STATUS: 0x270103, ENV: 0x270104, SYS_SETTINGS: 0x270106,
  BOTTOM: 0x270108, PING_RESULTS: 0x27010b, ERROR: 0x27010d,
};
const NAMES = Object.fromEntries(Object.entries(ID).map(([k, v]) => [v, k]));
const REQUIRED = [ID.ENV, ID.ERROR, ID.SYS_STATUS, ID.SYS_SETTINGS, ID.CHAN_SETTINGS];

// Pick local IPv4 like the app does (first address starting with 192.)
function pickIface() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === 'IPv4' && a.address.startsWith('192.')) return a.address;
  return undefined;
}
const iface = arg('--iface') ?? pickIface();
if (!iface) { console.error('No 192.x interface; pass --iface'); process.exit(1); }
console.log(`[init] interface ${iface}`);

// Raw log: [u64 ms][u8 channel 0=disc 1=data][u32 len][bytes]
const logFd = arg('--log') ? fs.openSync(arg('--log'), 'a') : null;
function logRaw(ch, buf) {
  if (logFd === null) return;
  const h = Buffer.alloc(13);
  h.writeBigUInt64LE(BigInt(Date.now()), 0); h.writeUInt8(ch, 8); h.writeUInt32LE(buf.length, 9);
  fs.writeSync(logFd, h); fs.writeSync(logFd, buf);
}

// Optional Signal K UDP delta output
const skTarget = arg('--sk')?.split(':');
const skSock = skTarget ? dgram.createSocket('udp4') : null;
function emitSk(values) {
  const delta = { updates: [{ $source: 'wifish', timestamp: new Date().toISOString(), values }] };
  if (skSock) skSock.send(JSON.stringify(delta), Number(skTarget[1]), skTarget[0]);
}

const ip4 = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const seen = new Map();
let service = null, unit = null, dataSock = null, ctrlSock = null, kaTimer = null;

// ---------- discovery ----------
const disc = dgram.createSocket({ type: 'udp4', reuseAddr: true });
disc.on('message', (b) => {
  logRaw(0, b);
  const id = b.readUInt32LE(0);
  if (id === ID.ANNOUNCE && b.length >= 36) {
    const svc = b.readUInt32LE(8);
    if (svc === 39 && !service) {
      service = { group: ip4(b, 20), port: b.readUInt32LE(24), device: ip4(b, 28), ctrlPort: b.readUInt32LE(32) };
      console.log('[disc] sonar service', service);
      maybeStart();
    } else if (svc !== 39 && !seen.has(`svc${svc}`)) {
      seen.set(`svc${svc}`, 1);
      console.log(`[disc] service ${svc} port=${b.readUInt32LE(24)} ${b.toString('hex', 16, 36)}`);
    }
  } else if (id === ID.UNIT && b.length >= 52 && !unit) {
    unit = { type: b.readUInt32LE(4), serial: b.readUInt32LE(8).toString(16), name: b.toString('latin1', 20, 52).replace(/\0.*$/, '') };
    console.log('[disc] unit', unit);
    maybeStart();
  } else {
    handleSonar(b, 'disc');
  }
});
disc.bind(DISCOVERY_PORT, () => { disc.addMembership(DISCOVERY_GROUP, iface); console.log('[disc] listening 224.0.0.1:5800'); });

// ---------- data + keepalive ----------
function maybeStart() {
  if (!service || !unit || dataSock) return;
  dataSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  dataSock.on('message', (b) => { logRaw(1, b); handleSonar(b, 'data'); });
  dataSock.bind(service.port, () => {
    dataSock.addMembership(service.group, iface);
    console.log(`[data] joined ${service.group}:${service.port}`);
  });
  if (NO_KEEPALIVE) { console.log('[ka] keepalive disabled'); return; }
  ctrlSock = dgram.createSocket('udp4');
  ctrlSock.bind(0, iface, () => { kaTimer = setInterval(sendKeepalive, 1000); sendKeepalive(); });
}

function sendKeepalive() {
  const k = Buffer.alloc(37);
  k.writeUInt32LE(ID.KEEPALIVE, 0); k.writeUInt32LE(37, 4); k.writeUInt32LE(VERSION, 8);
  k.writeUInt32LE(0xdeadbeef, 12);
  k.writeUInt8(REQUIRED.every((id) => seen.has(id)) ? 1 : 0, 16);
  k.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)), 17);
  k.writeBigInt64LE(-1n, 25);
  k.writeInt32LE(-0x80000000, 33);
  ctrlSock.send(k, service.ctrlPort, service.device);
}

// ---------- sonar4 decode ----------
const pings = new Map(); // seq -> { buf, next, total, type, setting }
const results = new Map(); // seq -> { channel, r0, r1 }
let depthCm = null, tempC = null;

function handleSonar(b, via) {
  if (b.length < 16) return;
  const id = b.readUInt32LE(0), len = b.readUInt32LE(4), ver = b.readUInt32LE(8);
  if (!(id >> 8 === 0x2701)) return;
  if (ver !== VERSION) { console.warn(`[warn] ${NAMES[id] ?? id.toString(16)} version ${ver}`); return; }
  if (!seen.has(id)) console.log(`[${via}] first ${NAMES[id] ?? '0x' + id.toString(16)} len=${len}`);
  seen.set(id, (seen.get(id) ?? 0) + 1);

  switch (id) {
    case ID.BOTTOM: {
      const d = b.readInt32LE(17);
      depthCm = d === -0x80000000 ? null : d;
      console.log(`[depth] ${depthCm === null ? '--' : (depthCm / 100).toFixed(2) + ' m'}  q=${b[16]} ch=${b[21]}`);
      if (depthCm !== null) emitSk([{ path: 'environment.depth.belowTransducer', value: depthCm / 100 }]);
      break;
    }
    case ID.ENV: {
      const t = b.readInt16LE(28);
      const nt = t === -0x8000 ? null : t / 100;
      if (nt !== tempC) { tempC = nt; console.log(`[env] water ${tempC ?? '--'} °C`); }
      if (tempC !== null) emitSk([{ path: 'environment.water.temperature', value: tempC + 273.15 }]);
      break;
    }
    case ID.ERROR:
      console.log(`[error] flags=0x${b.readUInt32LE(16).toString(16)}`); break;
    case ID.PING_RESULTS:
      results.set(b[16], { channel: b[95], r0: b.readInt32LE(104), r1: b.readInt32LE(108) });
      if (results.size > 32) results.delete(results.keys().next().value);
      break;
    case ID.PING_DATA: {
      if (b.readUInt32LE(16) !== 0) break;
      const off = b.readUInt32LE(20), total = b.readUInt32LE(24);
      const seq = b[33], seg = b[34], nseg = b[35];
      let p = pings.get(seq);
      if (seg === 0) { p = { buf: Buffer.alloc(total), next: 0, type: b[32], setting: b[36] }; pings.set(seq, p); }
      if (!p || p.next !== seg) { pings.delete(seq); break; }
      b.copy(p.buf, off, 37, len);
      p.next++;
      if (seg === nseg - 1) {
        pings.delete(seq);
        const r = results.get(seq);
        if ((seen.get(ID.PING_DATA) ?? 0) % 200 < nseg) // throttle
          console.log(`[ping] seq=${seq} n=${total} ch=${r?.channel ?? '?'} range=${r ? r.r0 + '..' + r.r1 : '?'} max=${Math.max(...p.buf)}`);
      }
      break;
    }
  }
}

process.on('SIGINT', () => {
  console.log('\n[summary] message counts:');
  for (const [id, n] of seen) console.log(`  ${NAMES[id] ?? id}: ${n}`);
  clearInterval(kaTimer);
  process.exit(0);
});
