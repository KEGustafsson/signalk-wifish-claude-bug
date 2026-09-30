import { describe, test, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Engine } from '../src/engine';
import { DemoDevice } from '../src/demo';
import { MsgId, parseChannelSettings } from '../src/sonar4';
import type { Transport, TransportEvents } from '../src/transport';
import type { Delta } from '../src/signalk';
import { msg, results, segment, channelSettings, systemSettings } from './helpers';

class FakeTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'device' as const;
  canSend = true;
  sent: Uint8Array[] = [];
  start() { this.emit('link', 'connected', 'fake'); }
  stop() { this.emit('link', 'offline', 'stopped'); }
  send(b: Uint8Array) { this.sent.push(b); }
  feed(b: Uint8Array) { this.emit('datagram', b); }
}

afterEach(() => { vi.useRealTimers(); });

describe('Engine', () => {
  test('publishes depth with the offset convention and temperature', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(systemSettings(1, 50));
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1050, 17)));
    t.feed(msg(MsgId.ENV, 68, (b) => b.writeInt16LE(1234, 28)));
    const values = deltas.flatMap((d) => d.updates[0].values);
    expect(values).toContainEqual({ path: 'environment.depth.belowTransducer', value: 10 });
    expect(values).toContainEqual({ path: 'environment.depth.belowSurface', value: 10.5 });
    expect(values).toContainEqual({ path: 'environment.water.temperature', value: 285.49 });
    e.stop();
  });

  test('clears a depth path that stops applying when the offset changes', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(systemSettings(1, 50));
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1050, 17)));
    deltas.length = 0;
    t.feed(systemSettings(2, 0));
    const values = deltas.flatMap((d) => d.updates[0].values);
    expect(values).toContainEqual({ path: 'environment.depth.belowSurface', value: null });
    expect(values).toContainEqual({ path: 'environment.depth.belowTransducer', value: 10.5 });
    deltas.length = 0;
    t.feed(systemSettings(3, -30));
    expect(deltas.flatMap((d) => d.updates[0].values)).toContainEqual({ path: 'environment.depth.belowKeel', value: 10.5 });
    e.stop();
  });

  test('publishes nothing for depth before the first bottom record', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(systemSettings(1, 50));
    expect(deltas).toHaveLength(0);
    e.stop();
  });

  test('can turn Signal K output off', () => {
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d), emitDepth: false, emitTemperature: false });
    e.start();
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1050, 17)));
    t.feed(msg(MsgId.ENV, 68, (b) => b.writeInt16LE(1234, 28)));
    expect(deltas).toHaveLength(0);
    e.stop();
  });

  test('keeps a bounded history and reports columns transducer-relative', () => {
    const t = new FakeTransport();
    const e = new Engine(t, { historyColumns: 3 });
    e.start();
    t.feed(systemSettings(1, 100));
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1100, 17)));
    for (let i = 0; i < 5; i++) {
      t.feed(results(i, 0, 0, 2000));
      t.feed(segment({ seq: i, seg: 0, count: 1, total: 3, offset: 0, data: [i, 2, 3], setting: 0 }));
    }
    const h = e.history('sonar');
    expect(h.map((c) => c.n)).toEqual([3, 4, 5]);
    expect(h[2]).toMatchObject({ ch: 'sonar', startCm: 0, endCm: 2000, bottomCm: 1000 });
    expect(Buffer.from(h[2].data, 'base64')).toEqual(Buffer.from([4, 2, 3]));
    expect(e.state().active).toEqual({ sonar: true, downvision: false });
    e.stop();
  });

  test('forwards settings changes to the transport, refuses when it cannot send', () => {
    const t = new FakeTransport();
    const e = new Engine(t);
    e.start();
    expect(e.setChannel('sonar', { gain: 10 })).toMatch(/No sonar data/);
    t.feed(channelSettings(0, 1));
    t.feed(results(1, 0, 0, 1000));
    t.feed(segment({ seq: 1, seg: 0, count: 1, total: 1, offset: 0, data: [1], setting: 0 }));
    expect(e.setChannel('sonar', { gain: 10 })).toBeNull();
    expect(parseChannelSettings(t.sent[0])).toMatchObject({ gain: 10, seq: 2 });
    expect(e.setSystem({ simulator: true })).toMatch(/not received/);
    t.canSend = false;
    expect(e.setChannel('sonar', { gain: 20 })).toMatch(/cannot be changed/);
    e.stop();
  });

  test('clears depth when data stops', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date', 'performance'] });
    const t = new FakeTransport();
    const deltas: Delta[] = [];
    const e = new Engine(t, { onDelta: (d) => deltas.push(d) });
    e.start();
    t.feed(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1000, 17)));
    vi.advanceTimersByTime(7000);
    const last = deltas.at(-1)!.updates[0].values;
    expect(last).toContainEqual({ path: 'environment.depth.belowTransducer', value: null });
    expect(e.state().depthCm).toBeNull();
    e.stop();
  });

  test('runs end to end against the demo sonar, including a settings round trip', () => {
    vi.useFakeTimers();
    const demo = new DemoDevice({ seed: 1, pingRate: 10 });
    const e = new Engine(demo);
    e.start();
    vi.advanceTimersByTime(3000);
    const s = e.state();
    expect(s.link).toBe('connected');
    expect(s.unit?.model).toBe('Dragonfly-4 Pro');
    expect(s.channels.sonar?.gainAuto).toBe(true);
    expect(e.history('sonar').length).toBeGreaterThan(10);
    expect(e.history('downvision').length).toBeGreaterThan(10);
    expect(s.depthCm).toBeGreaterThan(200);
    expect(e.setChannel('downvision', { gainAuto: false, gain: 90 })).toBeNull();
    vi.advanceTimersByTime(1500);
    expect(e.state().channels.downvision).toMatchObject({ gainAuto: false, gain: 90 });
    expect(e.setChannel('sonar', { rangeAuto: false, rangeShallowCm: 0, rangeDeepCm: 3000 })).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(e.history('sonar').at(-1)!.endCm).toBe(3000);
    expect(e.setSystem({ transducerOffsetCm: 50 })).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(e.state().system?.transducerOffsetCm).toBe(50);
    e.stop();
  });

  test('wifish demo only pings DownVision', () => {
    vi.useFakeTimers();
    const e = new Engine(new DemoDevice({ model: 'wifish' }));
    e.start();
    vi.advanceTimersByTime(2000);
    expect(e.state().unit?.wifish).toBe(true);
    expect(e.history('sonar')).toHaveLength(0);
    expect(e.history('downvision').length).toBeGreaterThan(5);
    e.stop();
  });
});
