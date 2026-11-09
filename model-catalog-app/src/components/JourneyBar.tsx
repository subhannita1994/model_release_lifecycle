import { useNav, type Nav } from '../store';
import type { UseCase } from '../types';
import { cx } from './primitives';

// Browse > Inspect > Compare > Intake > Sign-off > Deploy.
// Highlights the current step and carries the selected models + use case along.
type StepId = 'browse' | 'inspect' | 'compare' | 'intake' | 'signoff' | 'deploy';
const STEPS: { id: StepId; label: string }[] = [
  { id: 'browse', label: 'Browse' },
  { id: 'inspect', label: 'Inspect' },
  { id: 'compare', label: 'Compare' },
  { id: 'intake', label: 'Intake' },
  { id: 'signoff', label: 'Sign-off' },
  { id: 'deploy', label: 'Deploy' },
];

export function currentStep(n: Nav): StepId {
  if (n.page === 'model') return 'inspect';
  if (n.page === 'compare') return 'compare';
  if (n.page === 'intake') return n.intakeTab === 'new' ? 'intake' : n.deployFor ? 'deploy' : 'signoff';
  return 'browse';
}

export function JourneyBar({ useCases }: { useCases: UseCase[] }) {
  const nav = useNav();
  const step = currentStep(nav);
  const idx = STEPS.findIndex((s) => s.id === step);
  const ucName = useCases.find((u) => u.use_case_id === nav.useCase)?.display_name ?? nav.useCase;
  const inspectTarget = nav.modelId ?? nav.selected[0] ?? null;

  const goto = (id: StepId) => {
    if (id === 'browse') nav.go({ page: 'catalog', deployFor: null });
    if (id === 'inspect' && inspectTarget) nav.go({ page: 'model', modelId: inspectTarget, deployFor: null });
    if (id === 'compare') nav.go({ page: 'compare', deployFor: null });
    if (id === 'intake') nav.go({ page: 'intake', intakeTab: 'new', deployFor: null });
    if (id === 'signoff' || id === 'deploy') nav.go({ page: 'intake', intakeTab: 'tracker', deployFor: null });
  };

  return (
    <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-6 pb-3">
      <ol className="flex flex-wrap items-center gap-1" aria-label="Journey">
        {STEPS.map((s, i) => {
          const on = s.id === step;
          const done = i < idx;
          const disabled = s.id === 'inspect' && !inspectTarget;
          return (
            <li key={s.id} className="flex items-center">
              <button
                onClick={() => goto(s.id)}
                disabled={disabled}
                aria-current={on ? 'step' : undefined}
                title={s.id === 'deploy' ? 'Deploy from an approved request in the Requests tracker' : disabled ? 'Open a model first' : undefined}
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-[12px] font-medium transition',
                  on ? 'bg-ink text-white' : done ? 'text-ink hover:bg-paper-2' : 'text-ink-3 hover:bg-paper-2 hover:text-ink-2',
                  disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                )}
              >
                <span className={cx('num flex h-4 w-4 items-center justify-center rounded-full text-[10px]',
                  on ? 'bg-accent text-white' : done ? 'bg-ink text-white' : 'bg-paper-2 text-ink-3')}>
                  {i + 1}
                </span>
                {s.label}
              </button>
              {i < STEPS.length - 1 && <span className="mx-0.5 text-ink-3" aria-hidden>›</span>}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
        <span className="eyebrow">Carrying</span>
        <span className="rounded-pill bg-card px-2.5 py-1 shadow-lift">
          <span className="num">{nav.selected.length}</span> model{nav.selected.length === 1 ? '' : 's'}
        </span>
        <span className="rounded-pill bg-card px-2.5 py-1 shadow-lift">{ucName ?? 'No use case'}</span>
        {(nav.selected.length > 0 || nav.useCase) && (
          <button className="text-ink-3 underline-offset-2 hover:text-ink hover:underline" onClick={() => nav.go({ selected: [], useCase: null })}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
