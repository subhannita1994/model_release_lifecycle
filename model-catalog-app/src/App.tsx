import { useEffect, useState } from 'react';
import { api, useCatalog, useMe } from './api';
import { INTAKE_CHANGED, useNav, type Page } from './store';
import { JourneyBar } from './components/JourneyBar';
import { Notice, Pill, cx } from './components/primitives';
import { Catalog } from './pages/Catalog';
import { ModelDetails } from './pages/ModelDetails';
import { Compare } from './pages/Compare';
import { Intake } from './pages/Intake';

const NAV: { page: Page; label: string }[] = [
  { page: 'catalog', label: 'Catalog' },
  { page: 'compare', label: 'Compare' },
  { page: 'intake', label: 'Intake' },
];

/** In-app notification badge: governance = requests awaiting a decision; teams = their requests needing info. */
function useIntakeBadge(isGov: boolean | undefined) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (isGov === undefined) return;
    let alive = true;
    const load = () =>
      api.listIntake().then(
        (r) => {
          if (!alive) return;
          setCount(r.requests.filter((x) => (isGov ? x.status === 'submitted' : x.status === 'info_requested')).length);
        },
        () => {},
      );
    load();
    const t = window.setInterval(load, 60_000);
    window.addEventListener(INTAKE_CHANGED, load);
    return () => { alive = false; window.clearInterval(t); window.removeEventListener(INTAKE_CHANGED, load); };
  }, [isGov]);
  return count;
}

export function App() {
  const nav = useNav();
  const me = useMe();
  const catalog = useCatalog();
  const badge = useIntakeBadge(me ? me.isGovernance : undefined);
  const useCases = catalog.data?.useCases ?? [];

  return (
    <div id="scroll-root" className="h-screen overflow-y-auto">
      <header className="sticky top-0 z-30 border-b border-line bg-paper">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-6 pb-3 pt-4">
          <button className="flex items-center gap-3 text-left" onClick={() => nav.go({ page: 'catalog', deployFor: null })}>
            <span className="brand-mark flex h-9 w-9 items-center justify-center rounded" aria-hidden>
              <svg viewBox="0 0 100 100" className="h-5 w-5"><path d="M22 72V30l28 24 28-24v42" stroke="currentColor" strokeWidth="10" fill="none" strokeLinejoin="round" /></svg>
            </span>
            <span>
              <span className="brand-title block font-display text-[17px] font-semibold leading-tight tracking-[-.015em]" />
              <span className="brand-subtitle block text-[12px] text-ink-2" />
            </span>
          </button>

          <nav className="flex items-center gap-1 rounded-pill bg-card p-1 shadow-lift" aria-label="Main">
            {NAV.map((n) => {
              const on = nav.page === n.page || (n.page === 'catalog' && nav.page === 'model');
              return (
                <button
                  key={n.page}
                  onClick={() => nav.go({ page: n.page, deployFor: null, ...(n.page === 'intake' ? { intakeTab: nav.intakeTab } : {}) })}
                  className={cx('relative rounded-pill px-4 py-1.5 text-[13px] font-medium transition',
                    on ? 'text-white shadow-lift-float' : 'text-ink-2 hover:bg-paper-2 hover:text-ink')}
                  style={on ? { background: 'linear-gradient(90deg, var(--accent), var(--accent-2))' } : undefined}
                >
                  {n.label}
                  {n.page === 'intake' && badge > 0 && (
                    <span className="num absolute -right-1 -top-1 rounded-pill bg-ink px-1.5 text-[10px] leading-[16px] text-white" title="Requests needing your attention">
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2 text-[12px] text-ink-2">
            {me?.isGovernance && <Pill variant="tier-frontier">AI governance</Pill>}
            <span className="max-w-[240px] truncate">{me?.email || ''}</span>
          </div>
        </div>
        <JourneyBar useCases={useCases} />
      </header>

      <main className="mx-auto max-w-[1440px] px-6 pb-28 pt-6">
        {me && !me.hasUserToken && (
          <div className="mb-4">
            <Notice tone="warn">
              This app reads data as you, but no user token was forwarded. Ask the app owner to enable
              on-behalf-of-user authorization (scopes: sql, dashboards.genie).
            </Notice>
          </div>
        )}
        {nav.page === 'catalog' && <Catalog catalog={catalog} />}
        {nav.page === 'model' && nav.modelId && <ModelDetails key={nav.modelId} name={nav.modelId} />}
        {nav.page === 'compare' && <Compare catalog={catalog} />}
        {nav.page === 'intake' && <Intake catalog={catalog} me={me} />}
      </main>
    </div>
  );
}
