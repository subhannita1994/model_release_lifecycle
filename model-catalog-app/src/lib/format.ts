// Number formatting policy (copied from the FinOps framework, plus metric/date helpers).
// Components import these and never call toFixed inline.

const stripZeros = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

const smallAmount = (a: number): string => {
  if (a >= 0.01) return stripZeros(a.toFixed(4));
  const digits = Math.min(8, Math.ceil(-Math.log10(a)) + 1);
  return stripZeros(a.toFixed(digits));
};

export const DASH = '\u2014';

export function formatMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return DASH;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a === 0) return '$0';
  if (a < 0.01) return `${sign}$${smallAmount(a)}`;
  if (a < 1000) return `${sign}$${a.toFixed(2)}`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}

export function formatRate(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return DASH;
  return `$${n.toFixed(2)} / 1M`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !isFinite(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${stripZeros((ms / 1000).toFixed(1))}s`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return DASH;
  const a = Math.abs(n);
  if (a < 10_000) return Math.round(n).toLocaleString('en-US');
  if (a < 1_000_000) return `${stripZeros((a / 1000).toFixed(1))}K`;
  return `${stripZeros((a / 1e6).toFixed(1))}M`;
}

export function formatPercent1(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !isFinite(ratio)) return DASH;
  return `${stripZeros((ratio * 100).toFixed(1))}%`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return DASH;
  return Math.round(n).toLocaleString('en-US');
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return DASH;
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------- metrics
// Metric names come from use_case_config; these helpers only decide how to show them.
const METRIC_LABELS: Record<string, string> = {
  latency_p50_ms: 'p50 latency',
  latency_p95_ms: 'p95 latency',
  cost_per_1k: 'Cost / 1k requests',
  projected_monthly_cost: 'Projected monthly cost',
  avg_input_tokens: 'Avg input tokens',
  avg_output_tokens: 'Avg output tokens',
  error_rate: 'Error rate',
  json_validity: 'JSON validity',
  f1: 'F1',
  trigger_f1: 'Trigger F1',
  fraud_f1: 'Fraud F1',
  sentence_count_compliance: 'Sentence-count compliance',
};

export function metricLabel(name: string): string {
  if (METRIC_LABELS[name]) return METRIC_LABELS[name];
  const dot = name.indexOf('.');
  if (dot > 0) return `${titleCase(name.slice(0, dot))} \u00b7 ${name.slice(dot + 1)}`;
  return titleCase(name).replace(/\bF1\b/i, 'F1');
}

export function isOperationalMetric(name: string): boolean {
  return /_ms$|cost|tokens|error_rate/.test(name);
}

export function lowerIsBetter(name: string, direction?: string | null): boolean {
  if (direction === 'lte') return true;
  if (direction === 'gte') return false;
  return /_ms$|cost|error_rate|tokens/.test(name);
}

export function formatMetric(name: string, v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return DASH;
  if (/_ms$/.test(name)) return formatLatency(v);
  if (name === 'cost_per_1k' || name === 'projected_monthly_cost') return formatMoney(v);
  if (/tokens/.test(name)) return formatTokens(v);
  if (v >= 0 && v <= 1) return formatPercent1(v);
  return stripZeros(v.toFixed(2));
}

export function formatThreshold(name: string, direction: string | null | undefined, value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  return `${direction === 'lte' ? '\u2264' : '\u2265'} ${formatMetric(name, value)}`;
}
