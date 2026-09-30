// Wi-Fish Sonar web app: the Android app's sonar screen for a browser.

import { ColumnStore } from './history';
import { TraceView } from './trace';
import { PluginStream, setChannel, setSystem } from './stream';
import { prefs, savePrefs, type ViewConfig } from './prefs';
import { ICONS } from './icons';
import {
  aboutDialog, closeAll, helpDialog, mainSettings, messageBox, overflowMenu, sonarSettings, viewSwitcher,
  type Ctx, type DialogHandle,
} from './dialogs';
import { formatDepth, formatTemp, unitByCode, unitById, type DepthUnit } from '../../src/shared/units';
import type { ChannelName, WifishState } from '../../src/shared/api';

declare const __VERSION__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ model

let state: WifishState | null = null;
const listeners = new Set<(s: WifishState | null) => void>();
const stores: Record<ChannelName, ColumnStore> = {
  sonar: new ColumnStore('sonar'),
  downvision: new ColumnStore('downvision'),
};
const traces: Record<ChannelName, TraceView> = {
  sonar: new TraceView('sonar', stores.sonar, 'Sonar'),
  downvision: new TraceView('downvision', stores.downvision, 'DownVision'),
};
const ORDER: ChannelName[] = ['sonar', 'downvision'];
/** View forced while a settings popover is open (the app shows only that channel). */
let tempView: ViewConfig | null = null;
let backlogDone = false;

function depthUnit(): DepthUnit {
  if (prefs.depthUnit) return unitById(prefs.depthUnit);
  return state?.system ? unitByCode(state.system.depthUnit) : unitById('m');
}

function isWifish(): boolean {
  return !!state?.unit?.wifish;
}

function availableChannels(): ChannelName[] {
  if (isWifish()) return ['downvision'];
  const a = ORDER.filter((c) => state?.active[c]);
  return a.length ? a : ORDER;
}

function effectiveView(): ViewConfig {
  if (tempView) return tempView;
  const avail = availableChannels();
  if (avail.length === 1) return avail[0];
  return prefs.view;
}

// ------------------------------------------------------------------ layout

const tracesEl = $<HTMLDivElement>('traces');
tracesEl.append(traces.sonar.el, Object.assign(document.createElement('div'), { className: 'separator' }), traces.downvision.el);

function applyView(): void {
  const v = effectiveView();
  tracesEl.className = `traces ${v}`;
  traces.sonar.el.hidden = v === 'downvision';
  traces.downvision.el.hidden = v === 'sonar';
  for (const t of Object.values(traces)) t.invalidate();
}

function applyPrefs(): void {
  const u = depthUnit();
  const offset = state?.system?.transducerOffsetCm ?? 0;
  traces.sonar.palette = prefs.paletteSonar;
  traces.downvision.palette = prefs.paletteDownvision;
  for (const t of Object.values(traces)) {
    t.unit = u;
    t.offsetCm = offset;
    t.depthLines = prefs.depthLines;
    t.aScope = prefs.aScope;
    t.setSpeed(prefs.speed);
    t.invalidate();
  }
  paintDatabox();
}

// ------------------------------------------------------------------ toolbar

const btnSettings = $<HTMLButtonElement>('btn-settings');
const btnViews = $<HTMLButtonElement>('btn-views');
const btnPause = $<HTMLButtonElement>('btn-pause');
const btnSnapshot = $<HTMLButtonElement>('btn-snapshot');
const btnMore = $<HTMLButtonElement>('btn-more');
const btnFF = $<HTMLButtonElement>('btn-ff');
btnSettings.innerHTML = ICONS.sonar;
btnViews.innerHTML = ICONS.viewSwitcher;
btnSnapshot.innerHTML = ICONS.camera;
btnMore.innerHTML = ICONS.more;
btnFF.innerHTML = ICONS.fastForward;
for (const t of Object.values(traces)) t.gear.innerHTML = ICONS.gear;

const paused = () => Object.values(traces).some((t) => !t.live);

function paintPause(): void {
  const p = paused();
  btnPause.innerHTML = p ? ICONS.play : ICONS.pause;
  btnPause.title = p ? 'Resume' : 'Pause';
  btnPause.setAttribute('aria-label', btnPause.title);
  btnFF.hidden = !p;
  $('history-scroll').hidden = !p;
}

function setPaused(p: boolean): void {
  for (const t of Object.values(traces)) t.pause(p);
  paintPause();
}

btnPause.addEventListener('click', () => setPaused(!paused()));
btnFF.addEventListener('click', () => setPaused(false));

btnViews.addEventListener('click', () => {
  viewSwitcher(btnViews, effectiveView(), availableChannels(), (v) => { savePrefs({ view: v }); applyView(); });
});

let settingsDialog: DialogHandle | null = null;
function openSonarSettings(ch: ChannelName, anchor: HTMLElement): void {
  settingsDialog?.close();
  hideGears();
  // Like the app: while adjusting, show only the channel being adjusted.
  if (effectiveView() === 'split') { tempView = ch; applyView(); }
  settingsDialog = sonarSettings(ctx, ch, anchor, () => { settingsDialog = null; tempView = null; applyView(); });
}
btnSettings.addEventListener('click', () => openSonarSettings('downvision', btnSettings));

btnMore.addEventListener('click', () => {
  overflowMenu(btnMore, [
    { label: 'Settings', action: () => mainSettings(ctx) },
    { label: 'Help', action: () => helpDialog() },
    { label: 'About', action: () => aboutDialog(state, __VERSION__) },
  ]);
});

// ------------------------------------------------------------------ settings gear on tap (app: GestureContainer)

let gearTimer: number | undefined;
function hideGears(): void {
  for (const t of Object.values(traces)) t.gear.classList.remove('shown');
  window.clearTimeout(gearTimer);
}
function showGear(ch: ChannelName): void {
  if (isWifish()) return; // the Wi-Fish has its settings button in the toolbar
  const t = traces[ch];
  const shown = t.gear.classList.contains('shown');
  hideGears();
  if (shown) return;
  t.gear.classList.add('shown');
  gearTimer = window.setTimeout(hideGears, 5000);
}
for (const ch of ORDER) traces[ch].gear.addEventListener('click', (e) => { e.stopPropagation(); openSonarSettings(ch, traces[ch].gear); });

// ------------------------------------------------------------------ gestures

interface P { id: number; x: number; y: number; x0: number; y0: number }
const pointers = new Map<number, P>();
let gesture: 'none' | 'tap' | 'drag' | 'pinch' = 'none';
let pinch0: { dx: number; dy: number; speed: number } | null = null;
let longPress: number | undefined;
let downAt = 0;
let lastTap = 0;
let colCarry = 0;

function traceAt(x: number, y: number): TraceView | null {
  for (const t of Object.values(traces)) {
    if (t.el.hidden) continue;
    const r = t.el.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return t;
  }
  return null;
}
const shownTraces = () => Object.values(traces).filter((t) => !t.el.hidden);

tracesEl.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest('button')) return;
  tracesEl.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  if (pointers.size === 1) {
    gesture = 'tap';
    downAt = performance.now();
    colCarry = 0;
    window.clearTimeout(longPress);
    longPress = window.setTimeout(() => {
      if (gesture === 'tap') { gesture = 'none'; showDetails(e.clientX, e.clientY); }
    }, 650);
  } else if (pointers.size === 2) {
    window.clearTimeout(longPress);
    gesture = 'pinch';
    const [a, b] = [...pointers.values()];
    pinch0 = { dx: Math.abs(a.x - b.x), dy: Math.abs(a.y - b.y), speed: prefs.speed };
  }
});

tracesEl.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (gesture === 'tap' && Math.hypot(p.x - p.x0, p.y - p.y0) > 8) { gesture = 'drag'; window.clearTimeout(longPress); }
  if (gesture === 'drag') {
    // Horizontal: history (both traces together, like the app). Vertical: pan when zoomed.
    const speed = traces.sonar.speed;
    colCarry += -dx / speed;
    const whole = Math.trunc(colCarry);
    if (whole) {
      colCarry -= whole;
      for (const t of Object.values(traces)) t.scrollBy(whole);
      paintPause();
    }
    if (Math.abs(dy) > 0) for (const t of shownTraces()) t.panBy(dy);
  } else if (gesture === 'pinch' && pointers.size === 2 && pinch0) {
    const [a, b] = [...pointers.values()];
    const sx = Math.abs(a.x - b.x), sy = Math.abs(a.y - b.y);
    if (pinch0.dy > pinch0.dx) {
      // vertical pinch: zoom the water column
      const f = Math.max(0.2, sy) / Math.max(1, pinch0.dy);
      if (Math.abs(f - 1) > 0.02) {
        const cy = (a.y + b.y) / 2;
        for (const t of shownTraces()) t.zoomBy(f, cy - t.el.getBoundingClientRect().top);
        pinch0.dy = sy;
      }
    } else {
      const s = Math.max(1, Math.min(5, pinch0.speed * (sx / Math.max(1, pinch0.dx))));
      savePrefs({ speed: s });
      for (const t of Object.values(traces)) t.setSpeed(s);
    }
  }
});

function pointerEnd(e: PointerEvent): void {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  window.clearTimeout(longPress);
  if (!p) return;
  if (gesture === 'tap' && performance.now() - downAt < 500) {
    const now = performance.now();
    const t = traceAt(p.x, p.y);
    if (now - lastTap < 320 && t) {
      for (const tr of shownTraces()) tr.resetZoom(); // double tap: back to full range
      hideGears();
    } else if (t) {
      showGear(t.channel);
    }
    lastTap = now;
  }
  if (pointers.size === 0) {
    for (const t of Object.values(traces)) t.endGesture();
    gesture = 'none';
    pinch0 = null;
  }
}
tracesEl.addEventListener('pointerup', pointerEnd);
tracesEl.addEventListener('pointercancel', pointerEnd);

tracesEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const t = traceAt(e.clientX, e.clientY);
  if (e.ctrlKey && !e.deltaX && Math.abs(e.deltaY) < 20 && !e.altKey) {
    // trackpad pinch arrives as ctrl+wheel with small deltas: zoom
    const f = Math.exp(-e.deltaY / 100);
    for (const tr of shownTraces()) tr.zoomBy(f, t ? e.clientY - tr.el.getBoundingClientRect().top : undefined);
    return;
  }
  if (e.ctrlKey || e.altKey) {
    const s = Math.max(1, Math.min(5, prefs.speed * Math.exp(-e.deltaY / 400)));
    savePrefs({ speed: s });
    for (const tr of Object.values(traces)) tr.setSpeed(s);
    return;
  }
  const horiz = e.shiftKey ? e.deltaY : e.deltaX;
  if (Math.abs(horiz) > Math.abs(e.shiftKey ? 0 : e.deltaY)) {
    for (const tr of Object.values(traces)) tr.scrollBy(horiz / tr.speed);
    paintPause();
    return;
  }
  const f = Math.exp(-e.deltaY / 500);
  for (const tr of shownTraces()) tr.zoomBy(f, e.clientY - tr.el.getBoundingClientRect().top);
  for (const tr of shownTraces()) tr.endGesture();
}, { passive: false });

tracesEl.addEventListener('contextmenu', (e) => e.preventDefault());

function showDetails(x: number, y: number): void {
  const t = traceAt(x, y);
  if (!t) return;
  const r = t.el.getBoundingClientRect();
  const { col, depthCm } = t.pick(x - r.left, y - r.top);
  if (!col) return;
  const u = depthUnit();
  const off = state?.system?.transducerOffsetCm ?? 0;
  const d = formatDepth(depthCm + off, u);
  const b = formatDepth(col.bottomCm === null ? null : col.bottomCm + off, u);
  const temp = formatTemp(col.tempCentiC, prefs.tempUnit);
  const ago = Math.max(0, Math.round((Date.now() - col.t) / 1000));
  const when = ago < 60 ? `${ago} s ago` : ago < 3600 ? `${Math.floor(ago / 60)} min ${ago % 60} s ago` : new Date(col.t).toLocaleTimeString();
  messageBox(t.channel === 'sonar' ? 'Sonar' : 'DownVision',
    `Depth at point: ${d.whole}.${d.frac} ${d.symbol}\nBottom: ${b.whole}.${b.frac} ${b.symbol}\nWater: ${temp.whole}.${temp.frac} ${temp.symbol}\nTime: ${new Date(col.t).toLocaleTimeString()} (${when})`);
}

// ------------------------------------------------------------------ history scrollbar (app: HistoryScrollbarView)

const scrollEl = $<HTMLDivElement>('history-scroll');
const thumb = scrollEl.querySelector<HTMLDivElement>('.thumb')!;
function primary(): TraceView {
  return shownTraces()[0] ?? traces.downvision;
}
function paintScrollbar(): void {
  if (scrollEl.hidden) return;
  const t = primary();
  const first = t.store.first, last = t.store.last;
  const total = Math.max(1, last - first + 1);
  const vis = Math.min(total, t.visibleColumns());
  const w = scrollEl.clientWidth;
  const tw = Math.max(24, (vis / total) * w);
  const x = ((t.right - first + 1 - vis) / Math.max(1, total - vis)) * (w - tw);
  thumb.style.width = `${tw}px`;
  thumb.style.transform = `translateX(${Math.max(0, Math.min(w - tw, x || 0))}px)`;
}
scrollEl.addEventListener('pointerdown', (e) => {
  scrollEl.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const t = primary();
    const r = scrollEl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    const target = t.store.first + t.visibleColumns() + frac * (t.store.last - t.store.first - t.visibleColumns());
    const delta = Math.round(target - t.right);
    for (const tr of Object.values(traces)) tr.scrollBy(delta);
    paintPause();
  };
  move(e);
  scrollEl.addEventListener('pointermove', move);
  scrollEl.addEventListener('pointerup', () => scrollEl.removeEventListener('pointermove', move), { once: true });
});

// ------------------------------------------------------------------ snapshot

btnSnapshot.addEventListener('click', () => {
  const shown = shownTraces();
  const rect = tracesEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const c = document.createElement('canvas');
  c.width = Math.round(rect.width * dpr);
  c.height = Math.round(rect.height * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  g.fillStyle = '#242328';
  g.fillRect(0, 0, rect.width, rect.height);
  for (const t of shown) {
    const r = t.el.getBoundingClientRect();
    t.compose(g, r.left - rect.left, r.top - rect.top);
  }
  // databox
  const db = $('databox');
  const dr = db.getBoundingClientRect();
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(dr.left - rect.left, dr.top - rect.top, dr.width, dr.height);
  g.fillStyle = '#fff';
  g.font = '700 26px system-ui, sans-serif';
  g.textBaseline = 'top';
  const lines = [...db.querySelectorAll('.env')].map((e) => e.textContent?.replace(/(\d)([a-z°])/i, '$1 $2') ?? '');
  lines.forEach((l, i) => g.fillText(l, dr.left - rect.left + 12, dr.top - rect.top + 10 + i * 34));
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  a.download = `wifish-${ts}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
  const flash = $('flash');
  flash.hidden = false;
  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');
  window.setTimeout(() => { flash.hidden = true; }, 450);
});

// ------------------------------------------------------------------ databox, status

function paintDatabox(): void {
  const d = formatDepth(state?.depthCm ?? null, depthUnit());
  $('depth').textContent = `${d.whole}.`;
  $('depth-frac').textContent = d.frac;
  $('depth-unit').textContent = d.symbol;
  const t = formatTemp(state?.waterTempCentiC ?? null, prefs.tempUnit);
  $('temp').textContent = `${t.whole}.`;
  $('temp-frac').textContent = t.frac;
  $('temp-unit').textContent = t.symbol;
}

let lostDialog: DialogHandle | null = null;
let lowVoltDialog: DialogHandle | null = null;
let lowVoltShown = false;
let offlineTimer: number | undefined;
let streamOk = true;

function paintConnection(): void {
  const s = state;
  const anyData = stores.sonar.cols.length + stores.downvision.cols.length > 0;
  const showConnecting = !s || !streamOk || (!anyData && s.link !== 'connected') || (s.link !== 'connected' && s.link !== 'lost' && !anyData);
  const conn = $('connecting');
  conn.hidden = !showConnecting;
  $('connect-msg').textContent = !streamOk ? 'Connecting to Signal K…' : s ? s.message : 'Plugin not running';
  const offline = !s || !streamOk || s.link === 'offline' || s.link === 'searching';
  if (showConnecting && offline) {
    if (offlineTimer === undefined && $('offline').hidden) {
      offlineTimer = window.setTimeout(() => { offlineTimer = undefined; if (!$('connecting').hidden) $('offline').hidden = false; }, 6000);
    }
  } else {
    window.clearTimeout(offlineTimer);
    offlineTimer = undefined;
    $('offline').hidden = true;
  }
  $('offline-hint').textContent = !streamOk
    ? 'Cannot reach the Signal K server.'
    : !s ? 'The Wi-Fish plugin is not running. Enable it in the Signal K server’s plugin configuration.'
      : s.source === 'device'
        ? 'To view sonar, join this Signal K server to a Wi-Fish or Dragonfly Pro Wi-Fi access point.'
        : s.message;
  const ls = $('link-state');
  ls.textContent = s && s.source !== 'device' ? (s.source === 'demo' ? 'DEMO' : 'REPLAY') : '';

  // Lost connection (app: DisconnectFragment).
  if (s?.link === 'lost' && !lostDialog) {
    lostDialog = messageBox('Lost connection', 'Trying to restore connection to the sounder…', [{ label: 'Dismiss' }], { onClose: () => { lostDialog = null; } });
  } else if (s?.link !== 'lost' && lostDialog) {
    lostDialog.close();
  }
  // Low voltage (app: LowVoltageFragment); shown once per episode.
  if (s?.lowVoltage && !lowVoltShown) {
    lowVoltShown = true;
    const name = s.unit?.model ?? 'Sonar';
    lowVoltDialog = messageBox(`${name} voltage warning`, `${name} supply voltage too low. Sounder may stop functioning.`, [{ label: 'OK' }], { onClose: () => { lowVoltDialog = null; } });
  } else if (!s?.lowVoltage) {
    lowVoltShown = false;
    lowVoltDialog?.close();
  }
}

$('btn-retry').addEventListener('click', () => {
  $('offline').hidden = true;
  stream.open();
});

// Simulated-data label blinks every 2 s (app: sim_blink).
window.setInterval(() => {
  const el = $('sim-blink');
  if (state?.system?.simulator) el.hidden = !el.hidden;
  else el.hidden = true;
}, 1000);

function onState(s: WifishState | null): void {
  const prevWifish = isWifish();
  state = s;
  btnSettings.hidden = !isWifish();
  btnViews.hidden = isWifish();
  if (prevWifish !== isWifish()) applyView();
  applyView();
  applyPrefs();
  paintConnection();
  for (const l of listeners) l(s);
}

// ------------------------------------------------------------------ plugin connection

const ctx: Ctx = {
  state: () => state,
  depthUnit,
  async sendChannel(ch, patch) {
    try { onState(await setChannel(ch, patch)); } catch (e) { toast((e as Error).message); throw e; }
  },
  async sendSystem(patch) {
    try { onState(await setSystem(patch)); } catch (e) { toast((e as Error).message); throw e; }
  },
  applyPrefs: () => { applyPrefs(); applyView(); },
  onState(cb) { listeners.add(cb); return () => listeners.delete(cb); },
};

let toastTimer: number | undefined;
function toast(msg: string): void {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.append(el); }
  el.textContent = msg;
  el.classList.add('shown');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('shown'), 3500);
}

const stream = new PluginStream({
  state: onState,
  column(c) {
    stores[c.ch].add(c);
    const t = traces[c.ch];
    if (t.live || t.zoomed) t.invalidate();
    if (backlogDone && stores[c.ch].cols.length === 1) paintConnection();
  },
  reset() {
    for (const s of Object.values(stores)) s.clear();
    for (const t of Object.values(traces)) { t.scrollTo(null); t.resetZoom(); }
    paintPause();
  },
  live() {
    backlogDone = true;
    paintConnection();
  },
  connection(ok) {
    streamOk = ok;
    if (!ok) backlogDone = false;
    paintConnection();
  },
});

// ------------------------------------------------------------------ render loop

function frame(now: number): void {
  for (const t of Object.values(traces)) t.draw(now);
  paintScrollbar();
  requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) for (const t of Object.values(traces)) t.invalidate();
});

applyPrefs();
applyView();
paintPause();
paintConnection();
stream.open();
requestAnimationFrame(frame);
window.addEventListener('beforeunload', () => { closeAll(); stream.close(); });
