import { useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';

// Hand-built primitives (Card, Pill, DarkButton, GhostButton, Figure, SearchField come
// from the FinOps framework; the rest extend the same visual language). Colours,
// radii and shadows come only from theme.css via Tailwind tokens.

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------- Card
export function Card({ hover, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { hover?: boolean }) {
  return (
    <div
      {...rest}
      className={cx(
        'rounded-xl bg-card shadow-lift',
        hover && 'transition-[transform,box-shadow] duration-[280ms] ease-soft hover:-translate-y-0.5 hover:shadow-lift-hi',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Pill / badges
export type PillVariant =
  | 'tier-frontier' | 'tier-large' | 'tier-small' | 'neutral' | 'accent' | 'pass' | 'fail' | 'info' | 'warn' | 'muted';

const PILL: Record<PillVariant, string> = {
  'tier-frontier': 'bg-plum-wash text-plum',
  'tier-large': 'bg-amber-wash text-amber',
  'tier-small': 'bg-moss-wash text-moss',
  neutral: 'bg-paper-2 text-ink-2',
  accent: 'bg-accent-wash text-accent',
  pass: 'bg-pass-wash text-pass',
  fail: 'bg-fail-wash text-fail',
  info: 'bg-info-wash text-info',
  warn: 'bg-warn-wash text-warn',
  muted: 'bg-card-2 text-ink-3',
};

export function Pill({ variant = 'neutral', dot, children, className, title }: {
  variant?: PillVariant; dot?: boolean; children: ReactNode; className?: string; title?: string;
}) {
  return (
    <span
      title={title}
      className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-2.5 py-[3px] text-[11.5px] font-medium leading-[1.4]', PILL[variant], className)}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function tierPillVariant(tier: string | null | undefined): PillVariant {
  if (tier === 'frontier') return 'tier-frontier';
  if (tier === 'mid') return 'tier-large';
  if (tier === 'lightweight') return 'tier-small';
  return 'neutral';
}

export function TierBadge({ tier }: { tier: string | null | undefined }) {
  return <Pill variant={tierPillVariant(tier)} dot>{tier ? tier[0].toUpperCase() + tier.slice(1) : 'Unknown'}</Pill>;
}

const MODEL_STATUS: Record<string, PillVariant> = {
  experimental: 'info', approved: 'pass', production: 'pass', deprecated: 'fail', retired: 'muted',
};
export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = status || 'unknown';
  return <Pill variant={MODEL_STATUS[s] ?? 'neutral'}>{s[0].toUpperCase() + s.slice(1)}</Pill>;
}

const REQUEST_STATUS: Record<string, [PillVariant, string]> = {
  submitted: ['info', 'Submitted'],
  approved: ['pass', 'Approved'],
  rejected: ['fail', 'Rejected'],
  info_requested: ['warn', 'Info requested'],
  deployed: ['tier-frontier', 'Deployed'],
};
export function RequestStatusBadge({ status }: { status: string }) {
  const [v, label] = REQUEST_STATUS[status] ?? ['neutral', status];
  return <Pill variant={v} dot>{label}</Pill>;
}

export function PassFail({ pass, title }: { pass: boolean | null | undefined; title?: string }) {
  if (pass === null || pass === undefined) return <Pill variant="muted" title={title ?? 'Not evaluated'}>n/a</Pill>;
  return <Pill variant={pass ? 'pass' : 'fail'} title={title}>{pass ? 'Pass' : 'Fail'}</Pill>;
}

// ---------------------------------------------------------------- buttons
type Btn = ButtonHTMLAttributes<HTMLButtonElement> & { size?: 'sm' | 'md' };
const BTN_SIZE = { sm: 'px-3.5 py-1.5 text-[12px]', md: 'px-[18px] py-2.5 text-[13px]' };

export function DarkButton({ className, size = 'md', ...rest }: Btn) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill bg-ink font-medium text-white transition hover:bg-ink-hover active:translate-y-px disabled:cursor-not-allowed disabled:bg-ink-3',
        BTN_SIZE[size], className,
      )}
    />
  );
}

export function GhostButton({ className, size = 'md', ...rest }: Btn) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill border border-line-hi bg-card font-medium text-ink transition hover:bg-paper-2 disabled:cursor-not-allowed disabled:text-ink-3',
        BTN_SIZE[size], className,
      )}
    />
  );
}

export function LinkButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...rest} className={cx('text-left font-medium text-ink underline-offset-2 hover:underline', className)} />;
}

// ---------------------------------------------------------------- figures + KPIs
const FIG_SIZE = { sm: 'text-[15px]', md: 'text-[20px]', lg: 'text-[28px]' };
const TONE = { ink: 'text-ink', 'ink-2': 'text-ink-2', lava: 'text-accent', pass: 'text-pass', fail: 'text-fail' };

export function Figure({ label, value, size = 'md', tone = 'ink', hint }: {
  label: string; value: ReactNode; size?: keyof typeof FIG_SIZE; tone?: keyof typeof TONE; hint?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-1.5">{label}</div>
      <div className={cx('num font-medium leading-none', FIG_SIZE[size], TONE[tone])}>{value}</div>
      {hint && <div className="mt-1 text-[11.5px] text-ink-3">{hint}</div>}
    </div>
  );
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: keyof typeof TONE }) {
  return (
    <Card className="p-[18px]">
      <Figure label={label} value={value} hint={hint} tone={tone} size="md" />
    </Card>
  );
}

// ---------------------------------------------------------------- inputs
export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      <input
        className="input pl-9"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}

export function Field({ label, hint, required, children, className }: {
  label: string; hint?: string; required?: boolean; children: ReactNode; className?: string;
}) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1.5 block text-[12px] font-medium text-ink-2">
        {label}{required && <span className="text-accent"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function Select({ value, onChange, options, placeholder, className, disabled }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
  placeholder?: string; className?: string; disabled?: boolean;
}) {
  return (
    <select className={cx('input cursor-pointer', className)} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Checkbox({ checked, onChange, label, disabled, count }: {
  checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; count?: number;
}) {
  return (
    <label className={cx('flex cursor-pointer items-center gap-2 py-[3px] text-[12.5px]', disabled && 'cursor-not-allowed opacity-50')}>
      <input
        type="checkbox"
        className="h-3.5 w-3.5 cursor-pointer accent-[var(--ink)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label !== undefined && <span className="min-w-0 flex-1 truncate text-ink">{label}</span>}
      {count !== undefined && <span className="num text-[11px] text-ink-3">{count}</span>}
    </label>
  );
}

// ---------------------------------------------------------------- tabs
export function Tabs<T extends string>({ tabs, active, onChange, className }: {
  tabs: { id: T; label: string; badge?: number }[]; active: T; onChange: (id: T) => void; className?: string;
}) {
  return (
    <div role="tablist" className={cx('flex flex-wrap gap-1 border-b border-line', className)}>
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={cx(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition',
              on ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink',
            )}
          >
            {t.label}
            {!!t.badge && <span className="num rounded-pill bg-accent px-1.5 py-px text-[10.5px] text-white">{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- drawer
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 560 }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode;
  footer?: ReactNode; width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-[var(--scrim)]" onClick={onClose} />
      <div className="relative flex h-full max-w-full flex-col bg-paper shadow-drawer animate-[slideIn_.25s_ease-out]" style={{ width }}>
        <div className="flex items-start justify-between gap-4 border-b border-line bg-card px-6 py-5">
          <div className="min-w-0">
            <div className="font-display text-[16px] font-semibold tracking-[-.01em]">{title}</div>
            {subtitle && <div className="mt-1 text-[12.5px] text-ink-2">{subtitle}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-pill p-1.5 text-ink-2 hover:bg-paper-2">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="border-t border-line bg-card px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- states
export function EmptyState({ title, body, action, compact }: { title: string; body?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-6' : 'px-6 py-14')}>
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-paper-2 text-ink-3">
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 12h8" /></svg>
      </div>
      <div className="font-display text-[14px] font-semibold">{title}</div>
      {body && <div className="mt-1 max-w-[52ch] text-[12.5px] text-ink-2">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className ?? 'h-4 w-full')} />;
}

export function LoadingBlock({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 p-5" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className={cx('h-5', i % 3 === 2 ? 'w-2/3' : 'w-full')} />)}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-fail-wash px-4 py-3 text-[12.5px] text-fail" role="alert">
      <span className="font-semibold">Couldn't load.</span>
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onRetry && <button className="font-medium underline" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'pass' | 'fail'; children: ReactNode }) {
  const t = { info: 'bg-info-wash text-info', warn: 'bg-warn-wash text-warn', pass: 'bg-pass-wash text-pass', fail: 'bg-fail-wash text-fail' }[tone];
  return <div className={cx('rounded-lg px-4 py-3 text-[12.5px] leading-[1.55]', t)}>{children}</div>;
}

export function SectionTitle({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div>
        <h2 className="font-display text-[15px] font-semibold tracking-[-.01em]">{title}</h2>
        {sub && <p className="mt-0.5 text-[12.5px] text-ink-2">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(140px,220px)_1fr] gap-x-6 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="border-b border-line py-2.5 text-ink-2">{k}</dt>
          <dd className="min-w-0 break-words border-b border-line py-2.5">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export { cx };
