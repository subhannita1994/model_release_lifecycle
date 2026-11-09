import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BenchSummary, CatalogData, ExampleRow, GenieAnswer, IntakeForm, IntakeRequest, Me, MetricRow, Model,
  RunHistory, UsageDay, UseCase,
} from './types';

// Thin fetch wrapper for the FastAPI backend. Errors carry the backend's message.
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return data as T;
}

const post = <T>(path: string, body: unknown) => req<T>(path, { method: 'POST', body: JSON.stringify(body) });
const csv = (names: string[]) => encodeURIComponent(names.join(','));

export const api = {
  me: () => req<Me>('/api/me'),
  catalog: () => req<CatalogData>('/api/catalog'),
  model: (name: string) =>
    req<{ model: Model; summary: BenchSummary[]; useCases: UseCase[] }>(`/api/models/${encodeURIComponent(name)}`),
  history: (name: string) =>
    req<{ runs: RunHistory[]; requests: IntakeRequest[] }>(`/api/models/${encodeURIComponent(name)}/history`),
  usage: (name: string) =>
    req<{ inferenceTable: string | null; days: UsageDay[]; note?: string }>(`/api/models/${encodeURIComponent(name)}/usage`),
  metrics: (models: string[], useCase?: string | null) =>
    req<MetricRow[]>(`/api/metrics?models=${csv(models)}${useCase ? `&use_case=${encodeURIComponent(useCase)}` : ''}`),
  exampleRecords: (models: string[], useCase: string) =>
    req<{ record_id: string; models_with_output: number }[]>(
      `/api/examples/records?models=${csv(models)}&use_case=${encodeURIComponent(useCase)}`),
  examples: (models: string[], useCase: string, opts: { recordId?: string; limit?: number } = {}) =>
    req<ExampleRow[]>(
      `/api/examples?models=${csv(models)}&use_case=${encodeURIComponent(useCase)}` +
      `${opts.recordId ? `&record_id=${encodeURIComponent(opts.recordId)}` : ''}&limit=${opts.limit ?? 10}`),
  genieAsk: (form: IntakeForm) =>
    post<{ conversation_id: string; message_id: string; space_id: string }>('/api/genie/ask', form),
  genieMessage: (conv: string, msg: string) =>
    req<GenieAnswer>(`/api/genie/${encodeURIComponent(conv)}/${encodeURIComponent(msg)}`),
  listIntake: () => req<{ isGovernance: boolean; requests: IntakeRequest[] }>('/api/intake'),
  createIntake: (body: IntakeForm & {
    chosen_model: string; proposed_risk_tier: string | null; genie_conversation_id: string | null;
    genie_message_id: string | null; genie_recommendation: string | null;
  }) => post<{ request_id: string; status: string }>('/api/intake', body),
  decide: (id: string, body: { action: 'approve' | 'reject' | 'info'; risk_tier?: string | null; comment: string }) =>
    post<{ request_id: string; status: string; tag: string | null; warning: string | null }>(
      `/api/intake/${encodeURIComponent(id)}/decision`, body),
  respond: (id: string, reply: string) =>
    post<{ request_id: string; status: string }>(`/api/intake/${encodeURIComponent(id)}/respond`, { reply }),
};

// ------------------------------------------------------------------ hooks
export interface Async<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** Run an async loader when deps change; ignores stale responses. */
export function useAsync<T>(load: (() => Promise<T>) | null, deps: unknown[]): Async<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null, error: null, loading: !!load,
  });
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!load) { setState({ data: null, error: null, loading: false }); return; }
    const id = ++seq.current;
    setState((s) => ({ data: s.data, error: null, loading: true }));
    load().then(
      (data) => { if (id === seq.current) setState({ data, error: null, loading: false }); },
      (e: Error) => { if (id === seq.current) setState({ data: null, error: e.message || String(e), loading: false }); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

// Catalog data is shared by every page (journey bar, compare picker, intake form);
// fetch once per session and let pages force a refresh.
let catalogPromise: Promise<CatalogData> | null = null;
export function loadCatalog(force = false): Promise<CatalogData> {
  if (force || !catalogPromise) {
    catalogPromise = api.catalog();
    catalogPromise.catch(() => { catalogPromise = null; });
  }
  return catalogPromise;
}

export function useCatalog(): Async<CatalogData> {
  const [force, setForce] = useState(0);
  const a = useAsync(() => loadCatalog(force > 0), [force]);
  return { ...a, reload: () => setForce((n) => n + 1) };
}

let mePromise: Promise<Me> | null = null;
export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    if (!mePromise) mePromise = api.me();
    mePromise.then(setMe, () => setMe({ email: '', isGovernance: false, hasUserToken: false }));
  }, []);
  return me;
}
