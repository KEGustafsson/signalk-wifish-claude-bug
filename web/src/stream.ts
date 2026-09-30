// Connection to the plugin: SSE for state and columns, fetch for settings.

import { API_BASE, type ChannelName, type ChannelPatch, type ColumnMessage, type SystemPatch, type WifishState } from '../../src/shared/api';

export interface StreamHandlers {
  state(s: WifishState | null): void;
  column(c: ColumnMessage): void;
  reset(): void;
  live(): void;
  connection(ok: boolean): void;
}

export class PluginStream {
  #es: EventSource | null = null;
  constructor(private h: StreamHandlers) {}

  open(): void {
    this.close();
    const es = new EventSource(`${API_BASE}/stream`);
    this.#es = es;
    es.addEventListener('open', () => this.h.connection(true));
    es.addEventListener('error', () => this.h.connection(false));
    es.addEventListener('state', (e) => this.h.state(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('col', (e) => this.h.column(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('reset', () => this.h.reset());
    es.addEventListener('live', () => this.h.live());
  }

  close(): void {
    this.#es?.close();
    this.#es = null;
  }
}

async function post(path: string, body: unknown): Promise<WifishState> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as WifishState;
}

export const setChannel = (ch: ChannelName, patch: ChannelPatch) => post(`/channel/${ch}`, patch);
export const setSystem = (patch: SystemPatch) => post('/system', patch);
