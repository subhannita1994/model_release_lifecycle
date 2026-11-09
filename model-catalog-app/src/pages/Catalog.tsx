import { useMemo, useState } from 'react';
import type { Async } from '../api';
import type { BenchSummary, CatalogData, Model, UseCase } from '../types';
import { MAX_SELECTED, MIN_COMPARE, useNav } from '../store';
import {
  Card, Checkbox, DarkButton, EmptyState, ErrorNote, GhostButton, LinkButton, LoadingBlock, Pill, SearchField,
  Select, StatusBadge, TierBadge, cx,
} from '../components/primitives';
import { DASH, formatDate, formatLatency, formatMetric, metricLabel, titleCase } from '../lib/format';

// ------------------------------------------------------------------ shared helpers
export interface ModelRow extends Model {
  bench: BenchSummary[];
  lastBenchmarked: string | null;
}

/** A use case "passes" when every evaluated threshold passes (unpriced cost thresholds are reported, not failed). */
export function passesAll(s: BenchSummary): boolean {
  return s.thresholds_passed > 0 && s.thresholds_failed === 0;
}

export function buildRows(d: CatalogData): ModelRow[] {
  const by = new Map<string, BenchSummary[]>();
  d.summary.forEach((s) => by.set(s.model_service, [...(by.get(s.model_service) ?? []), s]));
  return d.models.map((m) => {
    const bench = (by.get(m.name) ?? []).slice().sort((a, b) => Number(passesAll(b)) - Number(passesAll(a)));
    const lastBenchmarked = bench.reduce<string | null>((a, s) => (!a || s.run_ts > a ? s.run_ts : a), null);
    return { ...m, bench, lastBenchmarked };
  });
}

export const shortUseCase = (uc: UseCase | undefined, id: string) => (uc?.display_name ?? id).split(' - ')[0];

export function UseCaseChip({ s, uc }: { s: BenchSummary; uc: UseCase | undefined }) {
  const ok = passesAll(s);
  const title =
    `${uc?.display_name ?? s.use_case_id}: ${s.thresholds_passed}/${s.thresholds_total} thresholds pass` +
    (s.thresholds_unknown ? `, ${s.thresholds_unknown} not evaluated (e.g. cost not priced yet)` : '') +
    ` \u00b7 ${metricLabel(s.primary_metric)} ${formatMetric(s.primary_metric, s.primary_value)}`;
  return (
    <Pill variant={ok ? 'pass' : 'fail'} title={title}>
      {shortUseCase(uc, s.use_case_id)}
      <span className="num opacity-80">{formatMetric(s.primary_metric, s.primary_value)}</span>
    </Pill>
  );
}

function UseCaseChips({ row, useCases }: { row: ModelRow; useCases: UseCase[] }) {
  if (!row.bench.length) return <Pill variant="muted">Not benchmarked yet</Pill>;
  return (
    <div className="flex flex-wrap gap-1">
      {row.bench.map((s) => <UseCaseChip key={s.use_case_id} s={s} uc={useCases.find((u) => u.use_case_id === s.use_case_id)} />)}
    </div>
  );
}

function p95For(row: ModelRow, useCase: string | null): { value: number | null; note: string } {
  if (useCase) {
    const s = row.bench.find((b) => b.use_case_id === useCase);
    return { value: s?.p95_ms ?? null, note: 'for the selected use case' };
  }
  const vals = row.bench.map((b) => b.p95_ms).filter((v): v is number => v !== null);
  return { value: vals.length ? Math.max(...vals) : null, note: 'worst across benchmarked use cases' };
}

// ------------------------------------------------------------------ filters
type FacetKey = 'provider' | 'capability_tier' | 'status' | 'hosting_type' | 'data_residency' | 'cost_tier';
const FACETS: { key: FacetKey; label: string }[] = [
  { key: 'provider', label: 'Provider' },
  { key: 'capability_tier', label: 'Capability tier' },
  { key: 'status', label: 'Status' },
  { key: 'hosting_type', label: 'Hosting type' },
  { key: 'data_residency', label: 'Data residency' },
  { key: 'cost_tier', label: 'Cost tier' },
];

interface Filters { q: string; facets: Partial<Record<FacetKey, string[]>>; benchmarked: string[]; approved: string[] }
const EMPTY: Filters = { q: '', facets: {}, benchmarked: [], approved: [] };

function matches(r: ModelRow, f: Filters): boolean {
  const q = f.q.trim().toLowerCase();
  if (q) {
    const hay = [r.name, r.underlying_model, r.provider, r.description, r.owner, r.version].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  for (const { key } of FACETS) {
    const sel = f.facets[key];
    if (sel && sel.length && !sel.includes(r[key] ?? 'unknown')) return false;
  }
  if (f.benchmarked.length && !f.benchmarked.some((u) => r.bench.some((b) => b.use_case_id === u))) return false;
  if (f.approved.length && !f.approved.some((u) => r.approved_use_cases.includes(u))) return false;
  return true;
}

const activeCount = (f: Filters) =>
  (f.q ? 1 : 0) + Object.values(f.facets).reduce((a, v) => a + (v?.length ?? 0), 0) + f.benchmarked.length + f.approved.length;

function FacetGroup({ label, options, selected, onChange }: {
  label: string; options: { value: string; label: string; count: number }[]; selected: string[]; onChange: (v: string[]) => void;
}) {
  if (!options.length) return null;
  return (
    <div className="border-t border-line pt-3">
      <div className="eyebrow mb-2">{label}</div>
      {options.map((o) => (
        <Checkbox
          key={o.value}
          checked={selected.includes(o.value)}
          onChange={(on) => onChange(on ? [...selected, o.value] : selected.filter((x) => x !== o.value))}
          label={o.label}
          count={o.count}
        />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ page
export function Catalog({ catalog }: { catalog: Async<CatalogData> }) {
  const nav = useNav();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [view, setView] = useState<'table' | 'cards'>('table');

  const useCases = catalog.data?.useCases ?? [];
  const rows = useMemo(() => (catalog.data ? buildRows(catalog.data) : []), [catalog.data]);
  const visible = useMemo(() => rows.filter((r) => matches(r, filters)), [rows, filters]);

  const facetOptions = (key: FacetKey) => {
    const counts = new Map<string, number>();
    rows.forEach((r) => counts.set(r[key] ?? 'unknown', (counts.get(r[key] ?? 'unknown') ?? 0) + 1));
    return [...counts.entries()].sort().map(([value, count]) => ({ value, label: titleCase(value), count }));
  };
  const ucOptions = (pred: (r: ModelRow, u: string) => boolean) =>
    useCases.map((u) => ({ value: u.use_case_id, label: shortUseCase(u, u.use_case_id), count: rows.filter((r) => pred(r, u.use_case_id)).length }));

  const open = (name: string) => nav.go({ page: 'model', modelId: name });
  const sel = nav.selected;
  const atMax = sel.length >= MAX_SELECTED;
  const benchmarkedCount = rows.filter((r) => r.bench.length).length;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
      {/* ---------------- filters */}
      <aside className="lg:sticky lg:top-[150px] lg:self-start">
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <span className="font-display text-[13px] font-semibold">Filters</span>
            {activeCount(filters) > 0 && (
              <button className="text-[12px] text-ink-2 hover:text-ink hover:underline" onClick={() => setFilters(EMPTY)}>
                Clear ({activeCount(filters)})
              </button>
            )}
          </div>
          <SearchField value={filters.q} onChange={(q) => setFilters({ ...filters, q })} placeholder="Search models" />
          {FACETS.map((f) => (
            <FacetGroup
              key={f.key}
              label={f.label}
              options={facetOptions(f.key)}
              selected={filters.facets[f.key] ?? []}
              onChange={(v) => setFilters({ ...filters, facets: { ...filters.facets, [f.key]: v } })}
            />
          ))}
          <FacetGroup
            label="Benchmarked for"
            options={ucOptions((r, u) => r.bench.some((b) => b.use_case_id === u))}
            selected={filters.benchmarked}
            onChange={(benchmarked) => setFilters({ ...filters, benchmarked })}
          />
          <FacetGroup
            label="Approved for"
            options={ucOptions((r, u) => r.approved_use_cases.includes(u))}
            selected={filters.approved}
            onChange={(approved) => setFilters({ ...filters, approved })}
          />
        </Card>
      </aside>

      {/* ---------------- results */}
      <section className="min-w-0">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-[20px] font-semibold tracking-[-.015em]">Model catalog</h1>
            <p className="mt-0.5 text-[12.5px] text-ink-2">
              {catalog.data
                ? <><span className="num">{visible.length}</span> of <span className="num">{rows.length}</span> model services · <span className="num">{benchmarkedCount}</span> benchmarked · select up to {MAX_SELECTED} to compare</>
                : 'Loading model services\u2026'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-[260px]">
              <Select
                value={nav.useCase ?? ''}
                onChange={(v) => nav.setUseCase(v || null)}
                placeholder="All use cases (p95 = worst)"
                options={useCases.map((u) => ({ value: u.use_case_id, label: u.display_name }))}
              />
            </div>
            <div className="flex rounded-pill bg-card p-1 shadow-lift" role="group" aria-label="View">
              {(['table', 'cards'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={cx('rounded-pill px-3 py-1 text-[12px] font-medium', view === v ? 'bg-ink text-white' : 'text-ink-2 hover:bg-paper-2')}
                >
                  {v === 'table' ? 'Table' : 'Cards'}
                </button>
              ))}
            </div>
            <GhostButton size="sm" onClick={catalog.reload}>Refresh</GhostButton>
          </div>
        </div>

        {catalog.error && <ErrorNote message={catalog.error} onRetry={catalog.reload} />}
        {!catalog.data && catalog.loading && <Card><LoadingBlock rows={8} /></Card>}

        {catalog.data && visible.length === 0 && (
          <Card>
            <EmptyState
              title="No model services match these filters"
              body="Try removing a filter or clearing the search."
              action={<GhostButton size="sm" onClick={() => setFilters(EMPTY)}>Clear filters</GhostButton>}
            />
          </Card>
        )}

        {catalog.data && visible.length > 0 && view === 'table' && (
          <Card className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-8" aria-label="Select" />
                  <th>Model</th>
                  <th>Provider</th>
                  <th>Version</th>
                  <th>Tier</th>
                  <th>Status</th>
                  <th>Use cases (latest run)</th>
                  <th>Cost tier</th>
                  <th className="text-right">p95</th>
                  <th>Owner</th>
                  <th>Created</th>
                  <th>Last benchmarked</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const p95 = p95For(r, nav.useCase);
                  const checked = sel.includes(r.name);
                  return (
                    <tr key={r.name} className={checked ? '[&>td]:bg-card-2' : undefined}>
                      <td>
                        <Checkbox checked={checked} disabled={!checked && atMax} onChange={() => nav.toggleSelected(r.name)} />
                      </td>
                      <td className="min-w-[200px]">
                        <LinkButton onClick={() => open(r.name)}>{r.name}</LinkButton>
                        <div className="text-[11.5px] text-ink-3">{r.underlying_model}</div>
                      </td>
                      <td>{titleCase(r.provider)}</td>
                      <td className="num text-[12px]">{r.version || DASH}</td>
                      <td><TierBadge tier={r.capability_tier} /></td>
                      <td><StatusBadge status={r.status} /></td>
                      <td className="min-w-[220px]"><UseCaseChips row={r} useCases={useCases} /></td>
                      <td>{titleCase(r.cost_tier)}</td>
                      <td className="num text-right" title={p95.note}>{formatLatency(p95.value)}</td>
                      <td>{r.owner || <span className="text-ink-3">Unassigned</span>}</td>
                      <td className="whitespace-nowrap text-ink-2">{formatDate(r.created_at)}</td>
                      <td className="whitespace-nowrap text-ink-2">{r.lastBenchmarked ? formatDate(r.lastBenchmarked) : <span className="text-ink-3">Never</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}

        {catalog.data && visible.length > 0 && view === 'cards' && (
          <div className="grid grid-cols-1 gap-[18px] md:grid-cols-2 xl:grid-cols-3">
            {visible.map((r) => {
              const p95 = p95For(r, nav.useCase);
              const checked = sel.includes(r.name);
              return (
                <Card key={r.name} hover className={cx('flex flex-col gap-3 p-5', checked && 'ring-2 ring-ink')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <LinkButton className="font-display text-[15px]" onClick={() => open(r.name)}>{r.name}</LinkButton>
                      <div className="truncate text-[12px] text-ink-3">{titleCase(r.provider)} · {r.underlying_model}</div>
                    </div>
                    <Checkbox checked={checked} disabled={!checked && atMax} onChange={() => nav.toggleSelected(r.name)} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <TierBadge tier={r.capability_tier} />
                    <StatusBadge status={r.status} />
                    <Pill variant="neutral">{titleCase(r.cost_tier)} cost</Pill>
                  </div>
                  <UseCaseChips row={r} useCases={useCases} />
                  <div className="mt-auto grid grid-cols-3 gap-3 border-t border-line pt-3 text-[12px]">
                    <div><div className="eyebrow mb-1">p95</div><div className="num" title={p95.note}>{formatLatency(p95.value)}</div></div>
                    <div><div className="eyebrow mb-1">Owner</div><div className="truncate">{r.owner || 'Unassigned'}</div></div>
                    <div><div className="eyebrow mb-1">Benchmarked</div><div>{r.lastBenchmarked ? formatDate(r.lastBenchmarked) : 'Never'}</div></div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ---------------- sticky compare bar */}
      {sel.length >= MIN_COMPARE && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
          <Card className="pointer-events-auto flex max-w-[1100px] flex-wrap items-center gap-3 px-4 py-3 shadow-lift-hi">
            <span className="eyebrow">Selected</span>
            <div className="flex max-w-[560px] flex-wrap gap-1.5">
              {sel.map((n) => (
                <span key={n} className="inline-flex items-center gap-1 rounded-pill bg-paper-2 py-0.5 pl-2.5 pr-1 text-[12px]">
                  {n}
                  <button aria-label={`Remove ${n}`} className="rounded-full px-1 text-ink-3 hover:text-ink" onClick={() => nav.toggleSelected(n)}>×</button>
                </span>
              ))}
            </div>
            <div className="w-[230px]">
              <Select
                value={nav.useCase ?? ''}
                onChange={(v) => nav.setUseCase(v || null)}
                placeholder="Choose a use case…"
                options={useCases.map((u) => ({ value: u.use_case_id, label: u.display_name }))}
              />
            </div>
            <DarkButton
              disabled={!nav.useCase}
              title={nav.useCase ? undefined : 'Choose a use case first'}
              onClick={() => nav.go({ page: 'compare' })}
            >
              Compare ({sel.length})
            </DarkButton>
            <button className="text-[12px] text-ink-3 hover:text-ink hover:underline" onClick={() => nav.setSelected([])}>Clear</button>
          </Card>
        </div>
      )}
    </div>
  );
}
