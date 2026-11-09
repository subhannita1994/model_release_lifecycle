import { useMemo, useState } from 'react';
import { api, useAsync, type Async } from '../api';
import type { CatalogData, MetricRow, UseCase } from '../types';
import { MAX_SELECTED, MIN_COMPARE, useNav } from '../store';
import {
  Card, DarkButton, EmptyState, ErrorNote, Figure, GhostButton, LinkButton, LoadingBlock, PassFail, Pill, SectionTitle,
  Select, TierBadge, cx,
} from '../components/primitives';
import { BarList, GroupedBars, Legend, seriesColor } from '../components/charts';
import {
  DASH, formatLatency, formatMetric, formatMoney, formatPercent1, formatThreshold, isOperationalMetric, lowerIsBetter,
  metricLabel,
} from '../lib/format';
import { passesAll } from './Catalog';
import { ExampleBody, pretty } from './ModelDetails';

const runKeyOf = (models: string[], uc: string | null) => (uc && models.length >= MIN_COMPARE ? `${uc}|${models.join(',')}` : null);

export function Compare({ catalog }: { catalog: Async<CatalogData> }) {
  const nav = useNav();
  const sel = nav.selected;
  const valid = sel.length >= MIN_COMPARE && sel.length <= MAX_SELECTED && !!nav.useCase;
  // Auto-run when arriving with a valid selection (e.g. from the catalog compare bar).
  const [runKey, setRunKey] = useState<string | null>(() => runKeyOf(sel, nav.useCase));
  const [runUc, runModelsCsv] = runKey ? runKey.split('|') : [null, ''];
  const runModels = useMemo(() => (runModelsCsv ? runModelsCsv.split(',') : []), [runModelsCsv]);
  const metrics = useAsync(runKey ? () => api.metrics(runModels, runUc) : null, [runKey]);

  const models = catalog.data?.models ?? [];
  const useCases = catalog.data?.useCases ?? [];
  const uc = useCases.find((u) => u.use_case_id === runUc);
  const stale = runKey !== null && runKey !== runKeyOf(sel, nav.useCase);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-[20px] font-semibold tracking-[-.015em]">Compare models</h1>
        <p className="mt-0.5 text-[12.5px] text-ink-2">Pick {MIN_COMPARE}–{MAX_SELECTED} model services and one use case. Results come from each model's latest benchmark run.</p>
      </div>

      {/* ---------------- controls */}
      <Card className="flex flex-col gap-4 p-5">
        {catalog.error && <ErrorNote message={catalog.error} onRetry={catalog.reload} />}
        <div>
          <div className="eyebrow mb-2">Models <span className="num normal-case tracking-normal">({sel.length}/{MAX_SELECTED})</span></div>
          <div className="flex flex-wrap gap-1.5">
            {!catalog.data && catalog.loading && <span className="text-[12px] text-ink-3">Loading models…</span>}
            {models.map((m) => {
              const on = sel.includes(m.name);
              const disabled = !on && sel.length >= MAX_SELECTED;
              return (
                <button
                  key={m.name}
                  onClick={() => nav.toggleSelected(m.name)}
                  disabled={disabled}
                  aria-pressed={on}
                  className={cx('rounded-pill border px-3 py-1 text-[12px] font-medium transition',
                    on ? 'border-ink bg-ink text-white' : 'border-line-hi bg-card text-ink-2 hover:bg-paper-2',
                    disabled && 'cursor-not-allowed opacity-40')}
                >
                  {m.name}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-[320px]">
            <div className="eyebrow mb-2">Use case</div>
            <Select
              value={nav.useCase ?? ''}
              onChange={(v) => nav.setUseCase(v || null)}
              placeholder="Choose a use case…"
              options={useCases.map((u) => ({ value: u.use_case_id, label: u.display_name }))}
            />
          </div>
          <DarkButton disabled={!valid} onClick={() => setRunKey(runKeyOf(sel, nav.useCase))}>
            Compare{sel.length ? ` (${sel.length})` : ''}
          </DarkButton>
          {!valid && (
            <span className="pb-2 text-[12px] text-ink-3">
              {sel.length < MIN_COMPARE ? `Select at least ${MIN_COMPARE} models.` : 'Choose a use case.'}
            </span>
          )}
          {valid && stale && <span className="pb-2 text-[12px] text-warn">Selection changed — press Compare to update.</span>}
        </div>
      </Card>

      {/* ---------------- results */}
      {!runKey && (
        <Card><EmptyState title="Nothing compared yet" body="Choose models and a use case, then press Compare." /></Card>
      )}
      {runKey && metrics.error && <ErrorNote message={metrics.error} onRetry={metrics.reload} />}
      {runKey && !metrics.data && !metrics.error && <Card><LoadingBlock rows={8} /></Card>}
      {runKey && metrics.data && uc && catalog.data && (
        <Results models={runModels} uc={uc} rows={metrics.data} catalog={catalog.data} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ results
function bestOf(name: string, direction: string | null | undefined, values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  if (v.length < 2) return null;
  return lowerIsBetter(name, direction) ? Math.min(...v) : Math.max(...v);
}

function Results({ models, uc, rows, catalog }: { models: string[]; uc: UseCase; rows: MetricRow[]; catalog: CatalogData }) {
  const nav = useNav();
  const [showAll, setShowAll] = useState(false);
  const get = (m: string, metric: string) => rows.find((r) => r.model_service === m && r.metric_name === metric);
  const allMetrics = useMemo(() => {
    const names = Array.from(new Set(rows.map((r) => r.metric_name)));
    const rest = names.filter((n) => !uc.headline_metrics.includes(n))
      .sort((a, b) => Number(isOperationalMetric(a)) - Number(isOperationalMetric(b)) || a.localeCompare(b));
    return [...uc.headline_metrics, ...rest];
  }, [rows, uc]);
  const shown = showAll ? allMetrics : allMetrics.filter((n) => uc.headline_metrics.includes(n) || n === 'latency_p95_ms' || n === 'projected_monthly_cost');
  const summaries = models.map((m) => catalog.summary.find((s) => s.model_service === m && s.use_case_id === uc.use_case_id));
  const modelMeta = (m: string) => catalog.models.find((x) => x.name === m);
  const series = models.map((m) => ({ key: m, label: m }));
  const quality = uc.headline_metrics.filter((n) => !isOperationalMetric(n));
  const qualityExtra = ['json_validity'].filter((n) => allMetrics.includes(n) && !quality.includes(n));
  const groups = [...quality, ...qualityExtra].map((n) => ({
    key: n, label: metricLabel(n), values: Object.fromEntries(models.map((m) => [m, get(m, n)?.metric_value ?? null])),
  }));
  const missing = models.filter((_, i) => !summaries[i]);

  return (
    <div className="flex flex-col gap-5">
      {missing.length > 0 && (
        <Card className="p-4 text-[12.5px] text-warn">
          Not benchmarked yet for {uc.display_name}: {missing.join(', ')}. Run the benchmark job for these models to compare them.
        </Card>
      )}

      {/* summary cards */}
      <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 xl:grid-cols-3">
        {models.map((m, i) => {
          const s = summaries[i];
          const meta = modelMeta(m);
          return (
            <Card key={m} className="flex flex-col gap-3 p-5" style={{ borderTop: `4px solid ${seriesColor(i)}` }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <LinkButton className="font-display text-[14px]" onClick={() => nav.go({ page: 'model', modelId: m })}>{m}</LinkButton>
                  <div className="truncate text-[11.5px] text-ink-3">{meta?.underlying_model}</div>
                </div>
                <TierBadge tier={meta?.capability_tier} />
              </div>
              {s ? (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <Figure size="sm" label={metricLabel(s.primary_metric)} value={formatMetric(s.primary_metric, s.primary_value)} />
                    <Figure size="sm" label="p95" value={formatLatency(s.p95_ms)} />
                    <Figure size="sm" label="Monthly" tone="lava" value={formatMoney(s.monthly_cost)} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Pill variant={passesAll(s) ? 'pass' : 'fail'}>{s.thresholds_passed}/{s.thresholds_total} thresholds pass</Pill>
                    {s.thresholds_unknown > 0 && <Pill variant="warn">{s.thresholds_unknown} not evaluated</Pill>}
                  </div>
                </>
              ) : <Pill variant="muted">Not benchmarked yet</Pill>}
            </Card>
          );
        })}
      </div>

      {/* metric table */}
      <Card className="overflow-x-auto">
        <div className="flex items-center justify-between px-5 pt-5">
          <SectionTitle title="Metrics" sub="Best value per row in bold. Thresholds come from use_case_config." />
          <GhostButton size="sm" onClick={() => setShowAll(!showAll)}>{showAll ? 'Headline only' : `Show all ${allMetrics.length} metrics`}</GhostButton>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Threshold</th>
              {models.map((m, i) => (
                <th key={m} className="text-right"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: seriesColor(i) }} />{m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((n) => {
              const cells = models.map((m) => get(m, n));
              const thr = cells.find((c) => c && c.threshold_value !== null);
              const best = bestOf(n, thr?.threshold_direction, cells.map((c) => c?.metric_value ?? null));
              return (
                <tr key={n}>
                  <td className={cx(uc.headline_metrics.includes(n) && 'font-semibold')}>{metricLabel(n)}</td>
                  <td className="num text-[12px] text-ink-2">{thr ? formatThreshold(n, thr.threshold_direction, thr.threshold_value) : DASH}</td>
                  {cells.map((c, i) => (
                    <td key={models[i]} className="text-right">
                      <span className="inline-flex items-center justify-end gap-1.5">
                        <span className={cx('num', c?.metric_value !== null && c?.metric_value === best && 'font-bold text-ink')}>
                          {n === 'error_rate' ? formatPercent1(c?.metric_value) : formatMetric(n, c?.metric_value)}
                        </span>
                        {c && c.threshold_value !== null && <PassFail pass={c.passes_threshold} />}
                      </span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* charts */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.3fr_1fr]">
        <Card className="p-5">
          <SectionTitle title="Quality" sub="Headline quality metrics (0–100%)." />
          {groups.length ? <GroupedBars groups={groups} series={series} format={formatPercent1} /> : <EmptyState compact title="No quality metrics" />}
        </Card>
        <div className="flex flex-col gap-5">
          <Card className="p-5">
            <SectionTitle title="Cost / 1k requests" />
            <BarList emptyLabel="Not priced" items={models.map((m, i) => {
              const v = get(m, 'cost_per_1k')?.metric_value ?? null;
              return { key: m, label: m, value: v, display: formatMoney(v), color: seriesColor(i) };
            })} />
          </Card>
          <Card className="p-5">
            <SectionTitle title="p95 latency" />
            <BarList items={models.map((m, i) => {
              const v = get(m, 'latency_p95_ms')?.metric_value ?? null;
              return { key: m, label: m, value: v, display: formatLatency(v), color: seriesColor(i) };
            })} />
          </Card>
        </div>
      </div>

      <ExampleCompare models={models} uc={uc} />

      <div className="flex justify-end">
        <DarkButton onClick={() => nav.go({ page: 'intake', intakeTab: 'new' })}>Continue to Intake →</DarkButton>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ side-by-side examples
function ExampleCompare({ models, uc }: { models: string[]; uc: UseCase }) {
  const key = `${uc.use_case_id}|${models.join(',')}`;
  const records = useAsync(() => api.exampleRecords(models, uc.use_case_id), [key]);
  const [idx, setIdx] = useState(0);
  const [showInput, setShowInput] = useState(false);
  const ids = records.data?.map((r) => r.record_id) ?? [];
  const recordId = ids[Math.min(idx, Math.max(0, ids.length - 1))];
  const ex = useAsync(recordId ? () => api.examples(models, uc.use_case_id, { recordId, limit: 12 }) : null, [key, recordId]);
  const first = ex.data?.[0];

  return (
    <Card className="p-5">
      <SectionTitle
        title="Example outputs, side by side"
        sub="Same gold record, every model's output from the latest run."
        right={ids.length > 0 && (
          <div className="flex items-center gap-2">
            <GhostButton size="sm" disabled={idx <= 0} onClick={() => setIdx(idx - 1)}>← Prev</GhostButton>
            <div className="w-[150px]">
              <Select value={recordId ?? ''} onChange={(v) => setIdx(Math.max(0, ids.indexOf(v)))} options={ids.map((id) => ({ value: id, label: id }))} />
            </div>
            <GhostButton size="sm" disabled={idx >= ids.length - 1} onClick={() => setIdx(idx + 1)}>Next →</GhostButton>
          </div>
        )}
      />
      {records.error && <ErrorNote message={records.error} onRetry={records.reload} />}
      {!records.data && !records.error && <LoadingBlock rows={4} />}
      {records.data && !ids.length && <EmptyState compact title="No stored examples for these models" />}
      {recordId && (
        <>
          {ex.error && <ErrorNote message={ex.error} onRetry={ex.reload} />}
          {!ex.data && !ex.error && <LoadingBlock rows={4} />}
          {ex.data && first && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div>
                  <button className="eyebrow mb-1 hover:text-ink" onClick={() => setShowInput(!showInput)} aria-expanded={showInput}>
                    {showInput ? '▾' : '▸'} Input ({recordId})
                  </button>
                  {showInput && <pre className="num max-h-[260px] overflow-auto whitespace-pre-wrap rounded bg-card-2 p-3 text-[11.5px]">{first.model_input || DASH}</pre>}
                </div>
                <div>
                  <div className="eyebrow mb-1">Expected</div>
                  <pre className="num max-h-[200px] overflow-auto whitespace-pre-wrap rounded bg-card-2 p-3 text-[11.5px]">{pretty(first.expected) || DASH}</pre>
                </div>
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(models.length, 3)}, minmax(0, 1fr))` }}>
                {models.map((m, i) => {
                  const e = ex.data!.find((x) => x.model_service === m);
                  return (
                    <div key={m} className="min-w-0 rounded-lg border border-line p-3" style={{ borderTop: `3px solid ${seriesColor(i)}` }}>
                      <div className="mb-2 truncate text-[12.5px] font-semibold">{m}</div>
                      {e ? <ExampleBody e={e} hideExpected /> : <div className="text-[12px] text-ink-3">No output stored for this record.</div>}
                    </div>
                  );
                })}
              </div>
              <Legend series={models.map((m) => ({ key: m, label: m }))} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
