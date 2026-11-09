import { create } from 'zustand';

// Navigation + journey state. The selected models and use case carry across every
// page (Browse > Inspect > Compare > Intake > Sign-off > Deploy) and are mirrored
// into the URL hash so links and the browser back button work.
export type Page = 'catalog' | 'model' | 'compare' | 'intake';
export type IntakeTab = 'new' | 'tracker';
export const MAX_SELECTED = 6;
export const MIN_COMPARE = 2;
/** Window event fired after any intake write so the nav badge and tracker refresh. */
export const INTAKE_CHANGED = 'mc:intake-changed';
export const notifyIntakeChanged = () => window.dispatchEvent(new Event(INTAKE_CHANGED));

export interface Nav {
  page: Page;
  modelId: string | null;
  selected: string[];
  useCase: string | null;
  intakeTab: IntakeTab;
  deployFor: string | null; // request id whose deploy wizard is open
}

interface Store extends Nav {
  go: (patch: Partial<Nav>) => void;
  toggleSelected: (name: string) => void;
  setSelected: (names: string[]) => void;
  setUseCase: (useCase: string | null) => void;
}

function parseHash(): Nav {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const q = new URLSearchParams(qs);
  const parts = path.split('/').filter(Boolean);
  const selected = (q.get('models') || '').split(',').filter(Boolean).slice(0, MAX_SELECTED);
  const base: Nav = { page: 'catalog', modelId: null, selected, useCase: q.get('uc'), intakeTab: 'new', deployFor: null };
  if (parts[0] === 'model' && parts[1]) return { ...base, page: 'model', modelId: decodeURIComponent(parts[1]) };
  if (parts[0] === 'compare') return { ...base, page: 'compare' };
  if (parts[0] === 'intake') {
    return { ...base, page: 'intake', intakeTab: parts[1] === 'tracker' ? 'tracker' : 'new', deployFor: q.get('deploy') };
  }
  return base;
}

function toHash(n: Nav): string {
  const q = new URLSearchParams();
  if (n.selected.length) q.set('models', n.selected.join(','));
  if (n.useCase) q.set('uc', n.useCase);
  if (n.page === 'intake' && n.deployFor) q.set('deploy', n.deployFor);
  const path =
    n.page === 'model' && n.modelId ? `model/${encodeURIComponent(n.modelId)}`
    : n.page === 'intake' ? `intake/${n.intakeTab}`
    : n.page;
  const s = q.toString();
  return `#/${path}${s ? `?${s}` : ''}`;
}

export const useNav = create<Store>((set, get) => ({
  ...parseHash(),
  go: (patch) => set(patch),
  toggleSelected: (name) => {
    const cur = get().selected;
    if (cur.includes(name)) set({ selected: cur.filter((n) => n !== name) });
    else if (cur.length < MAX_SELECTED) set({ selected: [...cur, name] });
  },
  setSelected: (names) => set({ selected: Array.from(new Set(names)).slice(0, MAX_SELECTED) }),
  setUseCase: (useCase) => set({ useCase }),
}));

// Page changes push a history entry; selection changes just replace the URL.
useNav.subscribe((s, prev) => {
  const h = toHash(s);
  if (window.location.hash === h) return;
  const pageChanged = s.page !== prev.page || s.modelId !== prev.modelId || s.intakeTab !== prev.intakeTab;
  if (pageChanged) {
    window.history.pushState(null, '', h);
    document.getElementById('scroll-root')?.scrollTo({ top: 0 });
  } else {
    window.history.replaceState(null, '', h);
  }
});

window.addEventListener('popstate', () => useNav.setState(parseHash()));
