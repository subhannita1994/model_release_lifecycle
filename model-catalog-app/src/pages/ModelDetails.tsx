import { useEffect, useMemo, useState } from 'react';
import { api, useAsync } from '../api';
import type { BenchSummary, ExampleRow, MetricRow, Model, UseCase } from '../types';
import { MAX_SELECTED, useNav } from '../store';
import {
  Card, DarkButton, EmptyState, ErrorNote, Figure, GhostButton, KeyValues, Kpi, LinkButton, LoadingBlock, Notice,
  PassFail, Pill, RequestStatusBadge, SectionTitle, StatusBadge, Tabs, TierBadge, cx,
} from '../components/primitives';
import { BarList, Columns } from '../components/charts';
import {
  DASH, formatCount, formatDate, formatDateTime, formatLatency, formatMetric, formatMoney, formatPercent1, formatRate,
  formatThreshold, formatTokens, isOperationalMetric, metricLabel, titleCase,
} from '../lib/format';
import { UseCaseChip, passesAll } from './Catalog';

type TabId = 'overview' | 'benchmarks' | 'cost' | 'spec' | 'licence' | 'usage' | 'history';
const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'benchmarks', label: 'Benchmarks' },
  { id: 'cost', label: 'Cost & performance' },
  { id: 'spec', label: 'Technical spec' },
  { id: 'licence', label: 'Licence & compliance' },
  { id: 'usage', label: 'Usage' },
  { id: 'history', label: 'History' },
];

const metricOf = (rows: MetricRow[], uc: string, name: string) =>
  rows.find((r) => r.use_case_id === uc && r.metric_name === name);

export function ModelDetails({ name }: { name: string }) {
  const nav = useNav();
  const d = useAsync(() => api.model(name), [name]);
  const [tab, setTab] = useState<TabId>('overview');
  const [wantMetrics, setWantMetrics] = useState(false);
  useEffect(() => { if (tab === 'benchmarks' || tab === 'cost') setWantMetrics(true); }, [tab]);
  const metrics = useAsync(wantMetrics ? () => api.metrics([name]) : null, [name, wantMetrics]);

  if (d.error) return <ErrorNote message={d.error} onRetry={d.reload} />;
  if (!d.data) return <Card><LoadingBlock rows={10} /></Card>;

  const { model: m, summary, useCases } = d.data;
  const inCompare = nav.selected.includes(m.name);

  const startIntake = () => {
    if (!inCompare) nav.setSelected([...nav.selected, m.name]);
    nav.go({ page: 'intake', intakeTab: 'new' });
  };

  return (
    <div className="flex flex-col gap-5">
      <Card className="p-6">
        <LinkButton className="mb-3 text-[12px] text-ink-2" onClick={() => nav.go({ page: 'catalog' })}>← Catalog</LinkButton>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-[22px] font-semibold tracking-[-.015em]">{m.name}</h1>
            <div className="mt-0.5 text-[13px] text-ink-2">
              {titleCase(m.provider)} · {m.underlying_model}{m.version ? ` · v${m.version}` : ''}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <TierBadge tier={m.capability_tier} />
              <StatusBadge status={m.status} />
              <Pill variant={m.licence_type === 'open_weights' ? 'tier-small' : 'neutral'}>{titleCase(m.licence_type)}</Pill>
              <Pill variant="neutral">{titleCase(m.cost_tier)} cost</Pill>
              {m.approved_use_cases.length > 0 && <Pill variant="pass">Approved for {m.approved_use_cases.length}</Pill>}
            </div>
            {m.description && <p className="mt-3 max-w-[90ch] text-[13px] text-ink-2">{m.description}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <GhostButton
              onClick={() => nav.toggleSelected(m.name)}
              disabled={!inCompare && nav.selected.length >= MAX_SELECTED}
              title={!inCompare && nav.selected.length >= MAX_SELECTED ? `Compare holds up to ${MAX_SELECTED} models` : undefined}
            >
              {inCompare ? `In compare (${nav.selected.length}) ✓` : 'Add to compare'}
            </GhostButton>
            <DarkButton onClick={startIntake}>Start intake</DarkButton>
          </div>
        </div>
      </Card>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'overview' && <Overview m={m} summary={summary} useCases={useCases} />}
      {tab === 'benchmarks' && <Benchmarks m={m} summary={summary} useCases={useCases} metrics={metrics} />}
      {tab === 'cost' && <CostPerf m={m} summary={summary} useCases={useCases} metrics={metrics} />}
      {tab === 'spec' && <Spec m={m} />}
      {tab === 'licence' && <Licence m={m} useCases={useCases} />}
      {tab === 'usage' && <Usage name={m.name} />}
      {tab === 'history' && <History m={m} useCases={useCases} />}
    </div>
  );
}

// ------------------------------------------------------------------ Overview
function Overview({ m, summary, useCases }: { m: Model; summary: BenchSummary[]; useCases: UseCase[] }) {
  const passing = summary.filter(passesAll);
  const p95s = summary.map((s) => s.p95_ms).filter((v): v is number => v !== null);
  const ucName = (id: string) => useCases.find((u) => u.use_case_id === id)?.display_name ?? id;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-[18px] md:grid-cols-4">
        <Kpi label="Benchmarked use cases" value={`${summary.length} / ${useCases.length}`} />
        <Kpi label="Passing all thresholds" value={passing.length} tone={passing.length ? 'pass' : 'ink'} />
        <Kpi label="Best p95 latency" value={formatLatency(p95s.length ? Math.min(...p95s) : null)} />
        <Kpi label="Approved for" value={m.approved_use_cases.length} hint={m.approved_use_cases.length ? undefined : 'No approvals yet'} />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle title="Latest benchmark results" sub="Pass = every evaluated threshold in use_case_config passes." />
          {summary.length ? (
            <div className="flex flex-col gap-2">
              {summary.map((s) => (
                <div key={s.use_case_id} className="flex items-center justify-between gap-3 rounded-lg bg-card-2 px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">{ucName(s.use_case_id)}</div>
                    <div className="text-[11.5px] text-ink-3">Run {formatDate(s.run_ts)} · n=<span className="num">{s.sample_size}</span></div>
                  </div>
                  <UseCaseChip s={s} uc={useCases.find((u) => u.use_case_id === s.use_case_id)} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState compact title="Not benchmarked yet" body="Run the model-catalog-benchmark job for this model service." />
          )}
        </Card>
        <Card className="p-5">
          <SectionTitle title="Key facts" />
          <KeyValues rows={[
            ['Provider', titleCase(m.provider)],
            ['Capability tier', <TierBadge key="t" tier={m.capability_tier} />],
            ['Hosting', titleCase(m.hosting_type)],
            ['Data residency', titleCase(m.data_residency)],
            ['Owner', m.owner || 'Unassigned'],
            ['Approved for', m.approved_use_cases.length ? m.approved_use_cases.map(ucName).join(', ') : 'Not approved for any use case'],
            ['In catalog since', formatDate(m.created_at)],
          ]} />
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Benchmarks
function Benchmarks({ m, summary, useCases, metrics }: {
  m: Model; summary: BenchSummary[]; useCases: UseCase[]; metrics: { data: MetricRow[] | null; error: string | null; reload: () => void };
}) {
  return (
    <div className="flex flex-col gap-4">
      {metrics.error && <ErrorNote message={metrics.error} onRetry={metrics.reload} />}
      {useCases.map((uc) => (
        <BenchCard key={uc.use_case_id} model={m.name} uc={uc} s={summary.find((x) => x.use_case_id === uc.use_case_id)} rows={metrics.data} />
      ))}
    </div>
  );
}

function BenchCard({ model, uc, s, rows }: { model: string; uc: UseCase; s: BenchSummary | undefined; rows: MetricRow[] | null }) {
  const [open, setOpen] = useState(false);
  if (!s) {
    return (
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div className="font-display text-[14px] font-semibold">{uc.display_name}</div>
          <Pill variant="muted">Not benchmarked yet</Pill>
        </div>
      </Card>
    );
  }
  const ucRows = (rows ?? []).filter((r) => r.use_case_id === uc.use_case_id);
  const headline = uc.headline_metrics.map((n) => ({ name: n, row: metricOf(ucRows, uc.use_case_id, n) }));
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-display text-[14px] font-semibold">{uc.display_name}</div>
          <div className="mt-0.5 text-[12px] text-ink-3">
            Run {formatDateTime(s.run_ts)} · n=<span className="num">{s.sample_size}</span> · dataset {s.dataset_version} · judge {s.judge_model}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Pill variant={passesAll(s) ? 'pass' : 'fail'}>
            {s.thresholds_passed}/{s.thresholds_total} thresholds pass
          </Pill>
          {s.thresholds_unknown > 0 && <Pill variant="warn" title="Usually cost: prices are still placeholders">{s.thresholds_unknown} not evaluated</Pill>}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-5 md:grid-cols-5">
        {headline.map(({ name, row }) => (
          <div key={name}>
            <Figure label={metricLabel(name)} value={formatMetric(name, row?.metric_value ?? (name === s.primary_metric ? s.primary_value : null))} />
            {row && row.threshold_value !== null && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                <PassFail pass={row.passes_threshold} /> {formatThreshold(name, row.threshold_direction, row.threshold_value)}
              </div>
            )}
          </div>
        ))}
        <Figure label="p95 latency" value={formatLatency(s.p95_ms)} />
        <Figure label="Monthly cost" value={formatMoney(s.monthly_cost)} tone="lava" hint={s.monthly_cost === null ? 'Not priced yet' : `at ${formatCount(uc.daily_volume)}/day`} />
      </div>
      <button className="mt-4 text-[12.5px] font-medium text-ink-2 hover:text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾ Hide all metrics and examples' : '▸ Show all metrics and examples'}
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <MetricTable rows={ucRows} loading={rows === null} />
          <ExampleList model={model} useCase={uc.use_case_id} />
        </div>
      )}
    </Card>
  );
}

function MetricTable({ rows, loading }: { rows: MetricRow[]; loading: boolean }) {
  if (loading) return <LoadingBlock rows={6} />;
  const sorted = rows.slice().sort((a, b) => Number(b.is_headline) - Number(a.is_headline) || Number(isOperationalMetric(a.metric_name)) - Number(isOperationalMetric(b.metric_name)) || a.metric_name.localeCompare(b.metric_name));
  return (
    <div className="max-h-[520px] overflow-y-auto rounded-lg border border-line">
      <table className="tbl">
        <thead><tr><th>Metric</th><th className="text-right">Value</th><th>Threshold</th><th /></tr></thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.metric_name}>
              <td className={cx(r.is_headline && 'font-semibold')}>{metricLabel(r.metric_name)}</td>
              <td className="num text-right">{formatMetric(r.metric_name, r.metric_value)}</td>
              <td className="num text-[12px] text-ink-2">{r.threshold_value !== null ? formatThreshold(r.metric_name, r.threshold_direction, r.threshold_value) : DASH}</td>
              <td>{r.threshold_value !== null && <PassFail pass={r.passes_threshold} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function pretty(s: string | null | undefined): string {
  if (!s) return '';
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

export function ExampleBody({ e, hideExpected }: { e: ExampleRow; hideExpected?: boolean }) {
  return (
    <div className="flex flex-col gap-2.5 text-[12px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill variant={e.json_valid ? 'pass' : 'fail'}>{e.json_valid ? 'Valid JSON' : 'Invalid JSON'}</Pill>
        <Pill variant="neutral"><span className="num">{formatLatency(e.latency_ms)}</span></Pill>
        <Pill variant="neutral"><span className="num">{formatTokens(e.input_tokens)} in / {formatTokens(e.output_tokens)} out</span></Pill>
        {Object.entries(e.scores ?? {}).map(([k, v]) => (
          <Pill key={k} variant={v >= 0.5 ? 'pass' : 'fail'}>{metricLabel(k)} <span className="num">{formatMetric(k, v)}</span></Pill>
        ))}
      </div>
      {e.error && <Notice tone="fail">{e.error}</Notice>}
      <div>
        <div className="eyebrow mb-1">Model output</div>
        <pre className="num max-h-[260px] overflow-auto whitespace-pre-wrap rounded bg-card-2 p-3 text-[11.5px]">{pretty(e.model_output) || DASH}</pre>
      </div>
      {!hideExpected && (
        <div>
          <div className="eyebrow mb-1">Expected</div>
          <pre className="num max-h-[200px] overflow-auto whitespace-pre-wrap rounded bg-card-2 p-3 text-[11.5px]">{pretty(e.expected) || DASH}</pre>
        </div>
      )}
      {e.judge_rationale && Object.keys(e.judge_rationale).length > 0 && (
        <div>
          <div className="eyebrow mb-1">Judge rationale</div>
          <div className="flex flex-col gap-1.5">
            {Object.entries(e.judge_rationale).map(([k, v]) => (
              <div key={k} className="rounded bg-card-2 px-3 py-2"><span className="font-medium">{metricLabel(k)}:</span> <span className="text-ink-2">{v}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ExampleList({ model, useCase }: { model: string; useCase: string }) {
  const ex = useAsync(() => api.examples([model], useCase, { limit: 10 }), [model, useCase]);
  const [openId, setOpenId] = useState<string | null>(null);
  if (ex.error) return <ErrorNote message={ex.error} onRetry={ex.reload} />;
  if (!ex.data) return <LoadingBlock rows={5} />;
  if (!ex.data.length) return <EmptyState compact title="No stored examples" />;
  return (
    <div>
      <div className="eyebrow mb-2">Examples (first {ex.data.length} records of the latest run)</div>
      <div className="flex flex-col gap-1.5">
        {ex.data.map((e) => (
          <div key={e.record_id} className="rounded-lg border border-line">
            <button
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-card-2"
              onClick={() => setOpenId(openId === e.record_id ? null : e.record_id)}
              aria-expanded={openId === e.record_id}
            >
              <span className="num">{e.record_id}</span>
              <span className="flex items-center gap-1.5">
                {!e.json_valid && <Pill variant="fail">Invalid JSON</Pill>}
                {e.error && <Pill variant="fail">Error</Pill>}
                <span className="text-ink-3">{openId === e.record_id ? '▾' : '▸'}</span>
              </span>
            </button>
            {openId === e.record_id && <div className="border-t border-line p-3"><ExampleBody e={e} /></div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Cost & performance
const OPS = ['cost_per_1k', 'projected_monthly_cost', 'latency_p50_ms', 'latency_p95_ms', 'error_rate', 'avg_input_tokens', 'avg_output_tokens'];

function CostPerf({ m, summary, useCases, metrics }: {
  m: Model; summary: BenchSummary[]; useCases: UseCase[]; metrics: { data: MetricRow[] | null; error: string | null; reload: () => void };
}) {
  const placeholder = m.price_source !== 'list_price';
  const bench = useCases.filter((u) => summary.some((s) => s.use_case_id === u.use_case_id));
  return (
    <div className="flex flex-col gap-5">
      {placeholder && (
        <Notice tone="warn">
          Prices for this service are placeholders (price_source = {m.price_source ?? 'unknown'}), so cost metrics are blank.
          Fill MODEL_PRICES in 02_model_services and refresh to populate them.
        </Notice>
      )}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle title="Pricing" />
          <KeyValues rows={[
            ['Price source', <Pill key="p" variant={placeholder ? 'warn' : 'pass'}>{titleCase(m.price_source)}</Pill>],
            ['Input (USD)', formatRate(m.usd_per_1m_input_tokens)],
            ['Output (USD)', formatRate(m.usd_per_1m_output_tokens)],
            ['Input (DBU / 1M)', m.dbu_per_1m_input_tokens ?? DASH],
            ['Output (DBU / 1M)', m.dbu_per_1m_output_tokens ?? DASH],
            ['USD per DBU', m.usd_per_dbu !== null ? formatMoney(m.usd_per_dbu) : DASH],
            ['Billing SKU', m.price_sku || DASH],
          ]} />
        </Card>
        <Card className="p-5">
          <SectionTitle title="p95 latency by use case" />
          {bench.length ? (
            <BarList items={bench.map((u) => {
              const s = summary.find((x) => x.use_case_id === u.use_case_id)!;
              return { key: u.use_case_id, label: u.display_name, value: s.p95_ms, display: formatLatency(s.p95_ms) };
            })} />
          ) : <EmptyState compact title="Not benchmarked yet" />}
        </Card>
      </div>
      <Card className="overflow-x-auto">
        {metrics.error && <div className="p-4"><ErrorNote message={metrics.error} onRetry={metrics.reload} /></div>}
        {!metrics.data && !metrics.error && <LoadingBlock rows={4} />}
        {metrics.data && (bench.length ? (
          <table className="tbl">
            <thead><tr><th>Use case</th>{OPS.map((o) => <th key={o} className="text-right">{metricLabel(o)}</th>)}</tr></thead>
            <tbody>
              {bench.map((u) => (
                <tr key={u.use_case_id}>
                  <td className="font-medium">{u.display_name}</td>
                  {OPS.map((o) => {
                    const r = metricOf(metrics.data!, u.use_case_id, o);
                    return (
                      <td key={o} className={cx('num text-right', r?.passes_threshold === false && 'text-fail')}>
                        {o === 'error_rate' ? formatPercent1(r?.metric_value) : formatMetric(o, r?.metric_value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <EmptyState compact title="No benchmark runs yet" />)}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Technical spec
function Spec({ m }: { m: Model }) {
  return (
    <Card className="p-5">
      <KeyValues rows={[
        ['Service name', <span key="n" className="num">{m.name}</span>],
        ['Unity Catalog name', <span key="f" className="num">{m.full_name}</span>],
        ['Underlying model', m.underlying_model || DASH],
        ['Version', m.version || DASH],
        ['Provider', titleCase(m.provider)],
        ['Capability tier', <TierBadge key="t" tier={m.capability_tier} />],
        ['Hosting type', titleCase(m.hosting_type)],
        ['Context window', m.context_window ? `${formatCount(m.context_window)} tokens` : 'Not recorded yet'],
        ['Supported API types', m.supported_api_types?.length ? m.supported_api_types.join(', ') : DASH],
        ['Inference table', m.inference_table ? <span key="i" className="num">{m.inference_table}</span> : DASH],
        ['Last catalog refresh', formatDateTime(m.last_refreshed_at)],
      ]} />
    </Card>
  );
}

// ------------------------------------------------------------------ Licence & compliance
function Licence({ m, useCases }: { m: Model; useCases: UseCase[] }) {
  const ucName = (id: string) => useCases.find((u) => u.use_case_id === id)?.display_name ?? id;
  const tags = Object.entries(m.tags ?? {}).sort();
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <SectionTitle title="Licence & compliance" />
        <KeyValues rows={[
          ['Licence type', titleCase(m.licence_type)],
          ['Licence terms', m.licence_url ? <a key="l" className="text-info underline" href={m.licence_url} target="_blank" rel="noreferrer">{m.licence_url}</a> : 'Not recorded yet'],
          ['Data residency', <Pill key="d" variant={m.data_residency === 'unverified' ? 'warn' : 'neutral'}>{titleCase(m.data_residency)}</Pill>],
          ['PII allowed', <Pill key="p" variant={m.pii_allowed === 'true' ? 'pass' : 'fail'}>{m.pii_allowed === 'true' ? 'Yes' : 'No'}</Pill>],
          ['Owner', m.owner || 'Unassigned'],
          ['Status', <StatusBadge key="s" status={m.status} />],
          ['Approved for', m.approved_use_cases.length ? m.approved_use_cases.map(ucName).join(', ') : 'Not approved for any use case'],
        ]} />
      </Card>
      <Card className="p-5">
        <SectionTitle title="Unity Catalog tags" sub="Governed tags on the model service." />
        {tags.length ? (
          <table className="tbl">
            <thead><tr><th>Tag</th><th>Value</th></tr></thead>
            <tbody>{tags.map(([k, v]) => <tr key={k}><td className="num text-[12px]">{k}</td><td>{v}</td></tr>)}</tbody>
          </table>
        ) : <EmptyState compact title="No tags" />}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Usage
function Usage({ name }: { name: string }) {
  const u = useAsync(() => api.usage(name), [name]);
  if (u.error) return <ErrorNote message={u.error} onRetry={u.reload} />;
  if (!u.data) return <Card><LoadingBlock rows={5} /></Card>;
  const days = u.data.days;
  if (!days.length) {
    return (
      <Card>
        <EmptyState title="No traffic in the last 30 days" body={u.data.note ?? `Inference table: ${u.data.inferenceTable ?? 'none'}`} />
      </Card>
    );
  }
  const total = days.reduce((a, d) => a + d.requests, 0);
  const errors = days.reduce((a, d) => a + d.errors, 0);
  const peakP95 = Math.max(...days.map((d) => d.p95_ms ?? 0));
  return (
    <div className="flex flex-col gap-5">
      <Notice tone="info">From the service's inference table ({u.data.inferenceTable}). Includes benchmark traffic.</Notice>
      <div className="grid grid-cols-2 gap-[18px] md:grid-cols-4">
        <Kpi label="Requests (30 days)" value={formatCount(total)} />
        <Kpi label="Error rate" value={formatPercent1(total ? errors / total : null)} tone={errors ? 'fail' : 'ink'} />
        <Kpi label="Peak daily p95" value={formatLatency(peakP95)} />
        <Kpi label="Active days" value={days.length} />
      </div>
      <Card className="p-5">
        <SectionTitle title="Requests per day" />
        <Columns points={days.map((d) => ({ key: d.day, label: d.day, value: d.requests }))} format={formatCount} />
        <table className="tbl mt-4">
          <thead><tr><th>Day</th><th className="text-right">Requests</th><th className="text-right">Errors</th><th className="text-right">p95</th><th className="text-right">Callers</th></tr></thead>
          <tbody>
            {days.slice().reverse().map((d) => (
              <tr key={d.day}>
                <td>{formatDate(d.day)}</td>
                <td className="num text-right">{formatCount(d.requests)}</td>
                <td className="num text-right">{formatCount(d.errors)}</td>
                <td className="num text-right">{formatLatency(d.p95_ms)}</td>
                <td className="num text-right">{d.requesters}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ History
function History({ m, useCases }: { m: Model; useCases: UseCase[] }) {
  const h = useAsync(() => api.history(m.name), [m.name]);
  const ucName = (id: string | null) => useCases.find((u) => u.use_case_id === id)?.display_name ?? id ?? DASH;
  const events = useMemo(() => [
    { at: m.created_at, what: 'Added to the catalog' },
    { at: m.updated_at, what: 'Catalog metadata last changed' },
    { at: m.last_refreshed_at, what: 'Last catalog refresh' },
  ].filter((e) => e.at), [m]);
  if (h.error) return <ErrorNote message={h.error} onRetry={h.reload} />;
  return (
    <div className="flex flex-col gap-5">
      <Card className="p-5">
        <SectionTitle title="Catalog" />
        <KeyValues rows={events.map((e) => [formatDateTime(e.at), e.what] as [string, string])} />
      </Card>
      <Card className="overflow-x-auto">
        <div className="px-5 pt-5"><SectionTitle title="Benchmark runs" /></div>
        {!h.data ? <LoadingBlock rows={4} /> : h.data.runs.length ? (
          <table className="tbl">
            <thead><tr><th>Run</th><th>Use case</th><th className="text-right">Sample</th><th>Primary metric</th><th>Thresholds</th><th>Judge</th><th>Run id</th></tr></thead>
            <tbody>
              {h.data.runs.map((r) => (
                <tr key={`${r.run_id}-${r.use_case_id}`}>
                  <td className="whitespace-nowrap">{formatDateTime(r.run_ts)}</td>
                  <td>{ucName(r.use_case_id)}</td>
                  <td className="num text-right">{r.sample_size}</td>
                  <td>{metricLabel(r.primary_metric)} <span className="num">{formatMetric(r.primary_metric, r.primary_value)}</span></td>
                  <td><Pill variant={r.thresholds_failed ? 'fail' : 'pass'}>{r.thresholds_failed ? `${r.thresholds_failed} failed` : 'All evaluated pass'}</Pill></td>
                  <td className="text-[12px] text-ink-2">{r.judge_model}</td>
                  <td className="num text-[11.5px] text-ink-3">{r.run_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <EmptyState compact title="No benchmark runs yet" />}
      </Card>
      <Card className="overflow-x-auto">
        <div className="px-5 pt-5"><SectionTitle title="Intake requests for this model" sub="You see your own requests; AI governance sees all." /></div>
        {!h.data ? <LoadingBlock rows={3} /> : h.data.requests.length ? (
          <table className="tbl">
            <thead><tr><th>Submitted</th><th>Project</th><th>Use case</th><th>Requested by</th><th>Status</th><th>Decided</th></tr></thead>
            <tbody>
              {h.data.requests.map((r) => (
                <tr key={r.request_id}>
                  <td className="whitespace-nowrap">{formatDate(r.created_at)}</td>
                  <td>{r.project}</td>
                  <td>{r.use_case_type || ucName(r.use_case_id)}</td>
                  <td className="text-ink-2">{r.requested_by}</td>
                  <td><RequestStatusBadge status={r.status} /></td>
                  <td className="text-ink-2">{r.decided_at ? `${formatDate(r.decided_at)} by ${r.decision_by}` : DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <EmptyState compact title="No intake requests yet" />}
      </Card>
    </div>
  );
}
