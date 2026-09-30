// HTTP API for the web app. Plain node req/res so it works both under the
// Signal K server's Express router and in the stand-alone dev server.
//
//   GET  api/state             current WifishState
//   GET  api/stream            Server-Sent Events: "state", "col" (backlog first, then live)
//   POST api/channel/:channel  ChannelPatch  (channel = sonar | downvision)
//   POST api/system            SystemPatch

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Engine } from './engine';
import { CHANNELS, type ChannelName, type ChannelPatch, type ColumnMessage, type SystemPatch, type WifishState } from './shared/api';

type Req = IncomingMessage & { body?: unknown };
type Res = ServerResponse & { flush?: () => void };

function sendJson(res: Res, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req: Req): Promise<unknown> {
  // Already consumed and parsed by the server's body parser.
  if (req.body !== undefined && req.readableEnded) return req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const BOOL_KEYS = ['rangeAuto', 'gainAuto', 'contrastAuto', 'noiseFilterAuto'] as const;
const PCT_KEYS = ['gain', 'contrast', 'noiseFilter'] as const;
const CM_KEYS = ['rangeShallowCm', 'rangeDeepCm'] as const;

/** Validated channel patch, or an error string. */
export function parseChannelPatch(body: unknown): ChannelPatch | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object';
  const b = body as Record<string, unknown>;
  const out: ChannelPatch = {};
  for (const k of Object.keys(b)) {
    if ((BOOL_KEYS as readonly string[]).includes(k)) {
      if (typeof b[k] !== 'boolean') return `${k} must be boolean`;
      (out as Record<string, unknown>)[k] = b[k];
    } else if ((PCT_KEYS as readonly string[]).includes(k)) {
      const v = b[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return `${k} must be 0..100`;
      (out as Record<string, unknown>)[k] = Math.round(v);
    } else if ((CM_KEYS as readonly string[]).includes(k)) {
      const v = b[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) return `${k} must be 0..100000 cm`;
      (out as Record<string, unknown>)[k] = Math.round(v);
    } else {
      return `unknown field ${k}`;
    }
  }
  if (out.rangeShallowCm !== undefined && out.rangeDeepCm !== undefined && out.rangeShallowCm >= out.rangeDeepCm) {
    return 'rangeShallowCm must be less than rangeDeepCm';
  }
  return Object.keys(out).length ? out : 'empty patch';
}

export function parseSystemPatch(body: unknown): SystemPatch | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object';
  const b = body as Record<string, unknown>;
  const out: SystemPatch = {};
  for (const k of Object.keys(b)) {
    if (k === 'simulator') {
      if (typeof b[k] !== 'boolean') return 'simulator must be boolean';
      out.simulator = b[k] as boolean;
    } else if (k === 'transducerOffsetCm') {
      const v = b[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 300) return 'transducerOffsetCm must be -300..300';
      out.transducerOffsetCm = Math.round(v);
    } else {
      return `unknown field ${k}`;
    }
  }
  return Object.keys(out).length ? out : 'empty patch';
}

/** Interleave both channels' backlogs by time so the viewer rebuilds history in order. */
export function backlog(engine: Pick<Engine, 'history'>): ColumnMessage[] {
  const all = CHANNELS.flatMap((c) => engine.history(c));
  return all.sort((a, b) => a.t - b.t);
}

export class Api {
  #engine: () => Engine | null;
  #clients = new Set<Res>();
  #unsub: (() => void) | null = null;
  #bound: Engine | null = null;

  /** `engine` is a getter so the plugin can swap engines on restart. */
  constructor(engine: () => Engine | null) {
    this.#engine = engine;
  }

  /** Route a request whose path is relative to the plugin root. Returns false when not ours. */
  async handle(req: Req, res: Res, path: string): Promise<boolean> {
    const method = req.method ?? 'GET';
    const engine = this.#engine();
    try {
      if (method === 'GET' && path === '/api/state') {
        if (!engine) sendJson(res, 503, { error: 'plugin not running' });
        else sendJson(res, 200, engine.state());
        return true;
      }
      if (method === 'GET' && path === '/api/stream') {
        this.#stream(req, res);
        return true;
      }
      const m = /^\/api\/channel\/(sonar|downvision)$/.exec(path);
      if (method === 'POST' && m) {
        if (!engine) return sendJson(res, 503, { error: 'plugin not running' }), true;
        const patch = parseChannelPatch(await readBody(req));
        if (typeof patch === 'string') return sendJson(res, 400, { error: patch }), true;
        const err = engine.setChannel(m[1] as ChannelName, patch);
        sendJson(res, err ? 409 : 200, err ? { error: err } : engine.state());
        return true;
      }
      if (method === 'POST' && path === '/api/system') {
        if (!engine) return sendJson(res, 503, { error: 'plugin not running' }), true;
        const patch = parseSystemPatch(await readBody(req));
        if (typeof patch === 'string') return sendJson(res, 400, { error: patch }), true;
        const err = engine.setSystem(patch);
        sendJson(res, err ? 409 : 200, err ? { error: err } : engine.state());
        return true;
      }
    } catch (e) {
      sendJson(res, 400, { error: (e as Error).message });
      return true;
    }
    return false;
  }

  /** Call after the engine was (re)created so live events reach connected viewers. */
  bind(): void {
    const engine = this.#engine();
    if (engine === this.#bound) return;
    this.#unsub?.();
    this.#unsub = null;
    this.#bound = engine;
    if (!engine) {
      this.#broadcast('state', null);
      return;
    }
    const onState = (s: WifishState) => this.#broadcast('state', s);
    const onCol = (c: ColumnMessage) => this.#broadcast('col', c);
    engine.on('state', onState);
    engine.on('column', onCol);
    this.#unsub = () => { engine.off('state', onState); engine.off('column', onCol); };
    this.#broadcast('reset', null);
    this.#broadcast('state', engine.state());
  }

  close(): void {
    this.#unsub?.();
    this.#unsub = null;
    this.#bound = null;
    for (const c of this.#clients) c.end();
    this.#clients.clear();
  }

  #stream(req: Req, res: Res): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 2000\n\n');
    const engine = this.#engine();
    this.#write(res, 'state', engine ? engine.state() : null);
    if (engine) for (const c of backlog(engine)) this.#write(res, 'col', c);
    this.#write(res, 'live', null);
    this.#clients.add(res);
    const ping = setInterval(() => { res.write(': ping\n\n'); res.flush?.(); }, 15_000);
    const done = () => { clearInterval(ping); this.#clients.delete(res); };
    req.on('close', done);
    res.on('close', done);
  }

  #write(res: Res, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.flush?.(); // compression middleware buffers otherwise
  }

  #broadcast(event: string, data: unknown): void {
    for (const c of this.#clients) this.#write(c, event, data);
  }
}
