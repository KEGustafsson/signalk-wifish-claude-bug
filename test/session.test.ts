import { describe, test, expect } from 'vitest';
import { Sonar4Session, type SessionColumn } from '../src/session';
import { MsgId, CS, SS, parseChannelSettings, parseSystemSettings } from '../src/sonar4';
import { msg, segment, results, channelSettings, systemSettings } from './helpers';

function columns(s: Sonar4Session): SessionColumn[] {
  const out: SessionColumn[] = [];
  s.on('column', (c) => out.push(c));
  return out;
}

describe('Sonar4Session', () => {
  test('pairs a column with its ping results and uses the auto range', () => {
    const s = new Sonar4Session();
    const cols = columns(s);
    s.handle(results(4, 1, 100, 1500));
    s.handle(segment({ seq: 4, seg: 0, count: 1, total: 3, offset: 0, data: [1, 2, 3], setting: 7 }));
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ channel: 1, configIndex: 7, startCm: 100, endCm: 1500 });
    expect(s.configIndex).toEqual([null, 7]);
  });

  test('uses the manual range from the channel settings when auto is off', () => {
    const s = new Sonar4Session();
    const cols = columns(s);
    s.handle(channelSettings(7, 1, { rangeAuto: 0, shallow: 200, deep: 900 }));
    s.handle(results(4, 0, 0, 1500));
    s.handle(segment({ seq: 4, seg: 0, count: 1, total: 2, offset: 0, data: [1, 2], setting: 7 }));
    expect(cols[0]).toMatchObject({ channel: 0, startCm: 200, endCm: 900 });
  });

  test('skips columns of a configuration held as disabled, and columns without results', () => {
    const s = new Sonar4Session();
    const cols = columns(s);
    s.handle(channelSettings(7, 1, { enabled: 0 }));
    s.handle(results(4, 0, 0, 1500));
    s.handle(segment({ seq: 4, seg: 0, count: 1, total: 2, offset: 0, data: [1, 2], setting: 7 }));
    s.handle(segment({ seq: 5, seg: 0, count: 1, total: 2, offset: 0, data: [1, 2], setting: 1 }));
    expect(cols).toHaveLength(0);
  });

  test('ignores a wrong protocol version and malformed messages', () => {
    const s = new Sonar4Session();
    const warns: string[] = [];
    s.on('warn', (w) => warns.push(w));
    const bad = msg(MsgId.BOTTOM, 22, (b) => b.writeUInt32LE(115, 8));
    expect(s.handle(bad)).toBeNull();
    expect(s.handle(msg(MsgId.ENV, 30))).toBeNull();
    expect(warns).toHaveLength(2);
  });

  test('is ready once every required message was seen', () => {
    const s = new Sonar4Session();
    s.handle(msg(MsgId.ENV, 68));
    s.handle(msg(MsgId.ERROR, 20));
    s.handle(msg(MsgId.SYS_STATUS, 1063));
    s.handle(systemSettings(1));
    expect(s.ready).toBe(false);
    s.handle(channelSettings(0, 1));
    expect(s.ready).toBe(true);
    s.reset();
    expect(s.ready).toBe(false);
  });

  test('only a newer settings seq replaces what is held', () => {
    const s = new Sonar4Session();
    s.handle(channelSettings(0, 5, { gain: 10 }));
    s.handle(channelSettings(0, 4, { gain: 90 }));
    expect(s.channelSettings(0)!.gain).toBe(10);
    s.handle(channelSettings(0, 6, { gain: 90 }));
    expect(s.channelSettings(0)!.gain).toBe(90);
  });

  test('channel commands: sensitivity for one channel, range for both, seq + 1', () => {
    const s = new Sonar4Session();
    s.handle(channelSettings(0, 5));
    s.handle(channelSettings(1, 9));
    s.handle(results(1, 0, 0, 1000)); s.handle(segment({ seq: 1, seg: 0, count: 1, total: 1, offset: 0, data: [1], setting: 0 }));
    s.handle(results(2, 1, 0, 1000)); s.handle(segment({ seq: 2, seg: 0, count: 1, total: 1, offset: 0, data: [1], setting: 1 }));

    const gain = s.buildChannelCommands(0, { gain: 80, gainAuto: false });
    expect(gain).toHaveLength(1);
    expect(parseChannelSettings(gain[0])).toMatchObject({ index: 0, seq: 6, gain: 80, gainAuto: false });

    const range = s.buildChannelCommands(1, { rangeAuto: false, rangeDeepCm: 3000, contrast: 20 });
    expect(range).toHaveLength(2);
    const [a, b] = range.map((r) => parseChannelSettings(r)!);
    expect(a).toMatchObject({ index: 0, seq: 7, rangeAuto: false, rangeDeepCm: 3000, contrast: 0 });
    expect(b).toMatchObject({ index: 1, seq: 10, rangeAuto: false, rangeDeepCm: 3000, contrast: 20 });
    expect(Buffer.from(range[1])[73]).toBe(0xab);
    // Our own echo (same seq) doesn't undo the local change.
    s.handle(channelSettings(0, 7, { gain: 50 }));
    expect(s.channelSettings(0)!.gain).toBe(80);
  });

  test('system command needs the device settings first', () => {
    const s = new Sonar4Session();
    expect(s.buildSystemCommand({ simulator: true })).toBeNull();
    s.handle(systemSettings(3, 0));
    const m = s.buildSystemCommand({ transducerOffsetCm: 45 })!;
    expect(parseSystemSettings(m)).toMatchObject({ seq: 4, transducerOffsetCm: 45 });
    expect(Buffer.from(m).readInt32LE(SS.TRANSDUCER_OFFSET)).toBe(45);
    expect(s.system!.transducerOffsetCm).toBe(45);
  });

  test('decodes unit, bottom and temperature events', () => {
    const s = new Sonar4Session();
    const unit = Buffer.alloc(52);
    unit.writeUInt32LE(1, 0); unit.writeUInt32LE(67, 4); unit.write('DF4', 20, 'latin1');
    s.handle(unit);
    s.handle(msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1234, 17)));
    s.handle(msg(MsgId.ENV, 68, (b) => b.writeInt16LE(1530, 28)));
    expect(s.unit).toMatchObject({ type: 67, name: 'DF4' });
    expect(s.bottomCm).toBe(1234);
    expect(s.waterTempCentiC).toBe(1530);
    expect(CS.GAIN).toBe(79);
  });
});
