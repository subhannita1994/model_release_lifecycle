import type { ReactNode } from 'react';

// Lightweight, dependency-free charts in the theme's colours.
export const seriesColor = (i: number) => `var(--series-${(i % 6) + 1})`;

export interface BarItem { key: string; label: ReactNode; value: number | null; display: string; color?: string; best?: boolean }

/** Horizontal bars, one per item; null values render as "not available". */
export function BarList({ items, emptyLabel = 'Not available' }: { items: BarItem[]; emptyLabel?: string }) {
  const max = Math.max(0, ...items.map((i) => (i.value ?? 0)));
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((i, idx) => {
        const pct = i.value !== null && max > 0 ? Math.max(2, (i.value / max) * 100) : 0;
        return (
          <div key={i.key} className="grid grid-cols-[minmax(110px,180px)_1fr_auto] items-center gap-3 text-[12.5px]">
            <div className="min-w-0 truncate text-ink-2">{i.label}</div>
            <div className="h-2.5 overflow-hidden rounded-pill bg-paper-2">
              {i.value !== null && (
                <div className="h-full rounded-pill transition-[width] duration-500" style={{ width: `${pct}%`, background: i.color ?? seriesColor(idx) }} />
              )}
            </div>
            <div className={`num min-w-[64px] text-right ${i.best ? 'font-semibold text-ink' : 'text-ink-2'}`}>
              {i.value === null ? <span className="text-ink-3">{emptyLabel}</span> : i.display}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export interface Series { key: string; label: string }
export interface Group { key: string; label: string; values: Record<string, number | null> }

/** Vertical grouped bars for 0..1 quality metrics: one group per metric, one bar per model. */
export function GroupedBars({ groups, series, format }: { groups: Group[]; series: Series[]; format: (v: number) => string }) {
  const H = 160;
  return (
    <div>
      <div className="flex items-end gap-6 overflow-x-auto pb-1">
        {groups.map((g) => (
          <div key={g.key} className="flex min-w-[96px] flex-col items-center">
            <div className="flex items-end gap-1" style={{ height: H }}>
              {series.map((s, i) => {
                const v = g.values[s.key];
                const h = v === null || v === undefined ? 0 : Math.max(2, Math.min(1, v) * H);
                return (
                  <div key={s.key} className="group relative flex w-3.5 flex-col justify-end" style={{ height: H }}>
                    <div
                      className="w-full rounded-t-[4px] transition-[height] duration-500"
                      style={{ height: h, background: seriesColor(i), opacity: v === null || v === undefined ? 0 : 1 }}
                      title={`${s.label}: ${v === null || v === undefined ? 'n/a' : format(v)}`}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-2 max-w-[120px] text-center text-[11.5px] leading-tight text-ink-2">{g.label}</div>
          </div>
        ))}
      </div>
      <Legend series={series} />
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {series.map((s, i) => (
        <span key={s.key} className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: seriesColor(i) }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Small daily column chart (usage tab). */
export function Columns({ points, format }: { points: { key: string; label: string; value: number }[]; format: (v: number) => string }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div className="flex h-[140px] items-end gap-1">
      {points.map((p) => (
        <div key={p.key} className="flex h-full flex-1 flex-col justify-end" title={`${p.label}: ${format(p.value)}`}>
          <div className="rounded-t-[3px] bg-info" style={{ height: `${Math.max(2, (p.value / max) * 100)}%` }} />
        </div>
      ))}
    </div>
  );
}
