import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, useAsync, type Async } from '../api';
import type { CatalogData, GenieAnswer, IntakeForm, IntakeRequest, Me } from '../types';
import { INTAKE_CHANGED, MAX_SELECTED, notifyIntakeChanged, useNav } from '../store';
import {
  Card, DarkButton, EmptyState, ErrorNote, Field, GhostButton, KeyValues, LoadingBlock, Notice, Pill,
  RequestStatusBadge, SearchField, SectionTitle, Select, Tabs, cx,
} from '../components/primitives';
import { DASH, formatDateTime, titleCase } from '../lib/format';
import { DeployDrawer } from './DeployDrawer';

const RISK = [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }];
const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));
const INPUT_FORMATS = opts(['Call transcripts', 'Emails', 'Free-text notes', 'Documents (PDF / scanned)', 'Structured records', 'Mixed / other']);
const LATENCY = opts(['Interactive (under 2s)', 'Near real-time (under 10s)', 'Batch (minutes are fine)']);
const COST = opts(['Low - quality matters most', 'Medium - balance quality and cost', 'High - lowest cost wins']);
const GROUND_TRUTH = opts(['Labelled data available', 'Partial - can be labelled', 'No labelled data']);
const OTHER = '__other__';

export function Intake({ catalog, me }: { catalog: Async<CatalogData>; me: Me | null }) {
  const nav = useNav();
  const list = useAsync(() => api.listIntake(), []);
  useEffect(() => {
    window.addEventListener(INTAKE_CHANGED, list.reload);
    return () => window.removeEventListener(INTAKE_CHANGED, list.reload);
  }, [list.reload]);
  const isGov = !!me?.isGovernance;
  const reqs = list.data?.requests ?? [];
  const badge = reqs.filter((r) => (isGov ? r.status === 'submitted' : r.status === 'info_requested')).length;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-[20px] font-semibold tracking-[-.015em]">Intake</h1>
        <p className="mt-0.5 text-[12.5px] text-ink-2">
          Describe the use case, get a recommendation from the Model Selection Advisor, pick a model and submit for AI governance sign-off.
        </p>
      </div>
      <Tabs
        tabs={[{ id: 'new', label: 'New request' }, { id: 'tracker', label: isGov ? 'Requests tracker (all)' : 'My requests', badge }]}
        active={nav.intakeTab}
        onChange={(t) => nav.go({ intakeTab: t, deployFor: null })}
      />
      {nav.intakeTab === 'new' ? <NewRequest catalog={catalog} /> : <Tracker list={list} me={me} catalog={catalog} />}
    </div>
  );
}

// ------------------------------------------------------------------ New request
const blankForm = (useCase: string | null, ucName: string): IntakeForm => ({
  project: '', environment: 'Lab', cost_centre: '', use_case_type: ucName, use_case_id: useCase,
  business_objective: '', input_data_source: '', input_format: '', input_volume: '', expected_outcome: '',
  quality_criteria: '', latency_requirement: '', cost_sensitivity: '', ground_truth_availability: '',
  regulatory_considerations: '', shortlisted_models: [],
});

type GenieState =
  | { phase: 'idle' }
  | { phase: 'asking' | 'polling'; conv?: string; msg?: string; status?: string }
  | { phase: 'done'; conv: string; msg: string; answer: GenieAnswer }
  | { phase: 'error'; error: string; conv?: string; msg?: string };

function NewRequest({ catalog }: { catalog: Async<CatalogData> }) {
  const nav = useNav();
  const useCases = catalog.data?.useCases ?? [];
  const models = catalog.data?.models ?? [];
  const ucName = (id: string | null) => useCases.find((u) => u.use_case_id === id)?.display_name ?? '';
  const [form, setForm] = useState<IntakeForm>(() => blankForm(nav.useCase, ''));
  const [genie, setGenie] = useState<GenieState>({ phase: 'idle' });
  const [chosen, setChosen] = useState('');
  const [risk, setRisk] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Fill the use-case name once the catalog arrives (journey carries the id).
  useEffect(() => {
    if (form.use_case_id && !form.use_case_type && useCases.length) setForm((f) => ({ ...f, use_case_type: ucName(f.use_case_id) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCases.length]);

  const set = <K extends keyof IntakeForm>(k: K, v: IntakeForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const payload = (): IntakeForm => ({ ...form, shortlisted_models: nav.selected });
  const missing = [!form.project.trim() && 'Project', !form.business_objective.trim() && 'Business objective'].filter(Boolean) as string[];

  const ask = async () => {
    setGenie({ phase: 'asking' });
    try {
      const r = await api.genieAsk(payload());
      setGenie({ phase: 'polling', conv: r.conversation_id, msg: r.message_id });
      for (let i = 0; i < 150 && alive.current; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        const a = await api.genieMessage(r.conversation_id, r.message_id);
        if (!alive.current) return;
        if (a.done) {
          if (a.status !== 'COMPLETED') {
            setGenie({ phase: 'error', error: a.error || `Genie finished with status ${a.status}`, conv: r.conversation_id, msg: r.message_id });
            return;
          }
          setGenie({ phase: 'done', conv: r.conversation_id, msg: r.message_id, answer: a });
          const rec = a.mentioned_models.find((m) => models.some((x) => x.name === m));
          setChosen((c) => c || rec || nav.selected[0] || '');
          setRisk((x) => x || a.risk_tier || '');
          return;
        }
        setGenie({ phase: 'polling', conv: r.conversation_id, msg: r.message_id, status: a.status });
      }
      if (alive.current) setGenie({ phase: 'error', error: 'Genie did not answer within 5 minutes.' });
    } catch (e) {
      if (alive.current) setGenie({ phase: 'error', error: (e as Error).message });
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const g = genie.phase === 'done' ? genie : null;
      const r = await api.createIntake({
        ...payload(),
        chosen_model: chosen,
        proposed_risk_tier: risk || null,
        genie_conversation_id: g?.conv ?? null,
        genie_message_id: g?.msg ?? null,
        genie_recommendation: g?.answer.text ?? null,
      });
      setDone(r.request_id);
      notifyIntakeChanged();
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <Card className="p-6">
        <EmptyState
          title="Request submitted"
          body={<>AI governance has been notified in the app. Request id <span className="num">{done}</span>.</>}
          action={
            <div className="flex gap-2">
              <DarkButton onClick={() => nav.go({ intakeTab: 'tracker' })}>View in tracker</DarkButton>
              <GhostButton onClick={() => { setDone(null); setForm(blankForm(nav.useCase, ucName(nav.useCase))); setGenie({ phase: 'idle' }); setChosen(''); setRisk(''); }}>
                Start another
              </GhostButton>
            </div>
          }
        />
      </Card>
    );
  }

  const ucSelect = form.use_case_id ?? (form.use_case_type ? OTHER : '');
  const choices = Array.from(new Set([
    ...(genie.phase === 'done' ? genie.answer.mentioned_models : []), ...nav.selected, ...models.map((m) => m.name),
  ])).filter((n) => models.some((m) => m.name === n));
  const busy = genie.phase === 'asking' || genie.phase === 'polling';

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-5">
        <FormCard title="Project">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Project" required><input className="input" value={form.project} onChange={(e) => set('project', e.target.value)} placeholder="e.g. Claims fraud triage" /></Field>
            <Field label="Environment" required>
              <Select value={form.environment} onChange={(v) => set('environment', v as 'Lab' | 'Prod')} options={[{ value: 'Lab', label: 'Lab' }, { value: 'Prod', label: 'Prod' }]} />
            </Field>
            <Field label="Cost centre"><input className="input" value={form.cost_centre} onChange={(e) => set('cost_centre', e.target.value)} /></Field>
          </div>
        </FormCard>

        <FormCard title="Use case">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Use case type" hint="Pick a benchmarked use case so approval can tag the model.">
              <Select
                value={ucSelect}
                onChange={(v) => {
                  if (v === OTHER) setForm((f) => ({ ...f, use_case_id: null, use_case_type: '' }));
                  else { setForm((f) => ({ ...f, use_case_id: v || null, use_case_type: ucName(v) })); nav.setUseCase(v || null); }
                }}
                placeholder="Choose…"
                options={[...useCases.map((u) => ({ value: u.use_case_id, label: u.display_name })), { value: OTHER, label: 'Other (not benchmarked yet)' }]}
              />
            </Field>
            {ucSelect === OTHER ? (
              <Field label="Describe the use case type"><input className="input" value={form.use_case_type} onChange={(e) => set('use_case_type', e.target.value)} placeholder="e.g. Document classification" /></Field>
            ) : <div />}
            <Field label="Business objective" required className="md:col-span-2">
              <textarea className="input min-h-[80px]" value={form.business_objective} onChange={(e) => set('business_objective', e.target.value)} placeholder="What decision or task will the model support, and for whom?" />
            </Field>
            <Field label="Expected outcome" className="md:col-span-2">
              <textarea className="input min-h-[60px]" value={form.expected_outcome} onChange={(e) => set('expected_outcome', e.target.value)} placeholder="What does a good output look like?" />
            </Field>
          </div>
        </FormCard>

        <FormCard title="Data">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Input data source"><input className="input" value={form.input_data_source} onChange={(e) => set('input_data_source', e.target.value)} placeholder="e.g. main.claims.call_transcripts" /></Field>
            <Field label="Input format"><Select value={form.input_format} onChange={(v) => set('input_format', v)} placeholder="Choose…" options={INPUT_FORMATS} /></Field>
            <Field label="Input volume"><input className="input" value={form.input_volume} onChange={(e) => set('input_volume', e.target.value)} placeholder="e.g. 20,000 calls / day" /></Field>
            <Field label="Ground-truth availability" className="md:col-span-3">
              <Select value={form.ground_truth_availability} onChange={(v) => set('ground_truth_availability', v)} placeholder="Choose…" options={GROUND_TRUTH} />
            </Field>
          </div>
        </FormCard>

        <FormCard title="Requirements">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Quality criteria" className="md:col-span-2">
              <textarea className="input min-h-[60px]" value={form.quality_criteria} onChange={(e) => set('quality_criteria', e.target.value)} placeholder="e.g. recall of fraud triggers at least 90%" />
            </Field>
            <Field label="Latency requirement"><Select value={form.latency_requirement} onChange={(v) => set('latency_requirement', v)} placeholder="Choose…" options={LATENCY} /></Field>
            <Field label="Cost sensitivity"><Select value={form.cost_sensitivity} onChange={(v) => set('cost_sensitivity', v)} placeholder="Choose…" options={COST} /></Field>
            <Field label="Regulatory considerations" className="md:col-span-2">
              <textarea className="input min-h-[60px]" value={form.regulatory_considerations} onChange={(e) => set('regulatory_considerations', e.target.value)} placeholder="PII, data residency, customer-facing decisions, model risk policy…" />
            </Field>
          </div>
        </FormCard>

        <FormCard title={`Shortlisted models (${nav.selected.length}/${MAX_SELECTED})`} sub="Carried from Browse / Compare. Click to add or remove.">
          <div className="flex flex-wrap gap-1.5">
            {models.map((m) => {
              const on = nav.selected.includes(m.name);
              return (
                <button
                  key={m.name}
                  onClick={() => nav.toggleSelected(m.name)}
                  disabled={!on && nav.selected.length >= MAX_SELECTED}
                  aria-pressed={on}
                  className={cx('rounded-pill border px-3 py-1 text-[12px] font-medium transition',
                    on ? 'border-ink bg-ink text-white' : 'border-line-hi bg-card text-ink-2 hover:bg-paper-2', !on && nav.selected.length >= MAX_SELECTED && 'opacity-40')}
                >
                  {m.name}
                </button>
              );
            })}
          </div>
        </FormCard>
      </div>

      {/* ---------------- Genie + submit */}
      <div className="flex flex-col gap-5 xl:sticky xl:top-[150px] xl:self-start">
        <Card className="p-5">
          <SectionTitle title="Model Selection Advisor" sub="Genie reads the catalog's benchmark results to recommend a model." />
          <DarkButton onClick={ask} disabled={busy || missing.length > 0} title={missing.length ? `Fill in: ${missing.join(', ')}` : undefined}>
            {busy ? 'Asking Genie…' : genie.phase === 'done' ? 'Ask again' : 'Get recommendation'}
          </DarkButton>
          {missing.length > 0 && <div className="mt-2 text-[12px] text-ink-3">Fill in {missing.join(' and ')} first.</div>}
          <div className="mt-4">
            {busy && (
              <div className="flex flex-col gap-2">
                <div className="text-[12px] text-ink-2">{genie.phase === 'polling' && genie.status ? titleCase(genie.status.toLowerCase()) : 'Starting'}…</div>
                <LoadingBlock rows={4} />
              </div>
            )}
            {genie.phase === 'error' && <ErrorNote message={genie.error} />}
            {genie.phase === 'done' && <GenieAnswerView a={genie.answer} />}
            {genie.phase === 'idle' && <div className="text-[12.5px] text-ink-3">The answer appears here. You can still submit without it, but governance will see that no recommendation was recorded.</div>}
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle title="Submit" />
          <div className="flex flex-col gap-4">
            <Field label="Chosen model" required>
              <Select value={chosen} onChange={setChosen} placeholder="Choose a model…" options={choices.map((n) => ({ value: n, label: n }))} />
            </Field>
            <Field label="Proposed risk tier" hint={genie.phase === 'done' && genie.answer.risk_tier ? `Genie proposed ${genie.answer.risk_tier}.` : undefined}>
              <Select value={risk} onChange={setRisk} placeholder="Choose…" options={RISK} />
            </Field>
            {submitError && <ErrorNote message={submitError} />}
            <DarkButton onClick={submit} disabled={submitting || !chosen || missing.length > 0}>
              {submitting ? 'Submitting…' : 'Submit for sign-off'}
            </DarkButton>
          </div>
        </Card>
      </div>
    </div>
  );
}

function FormCard({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <SectionTitle title={title} sub={sub} />
      {children}
    </Card>
  );
}

function GenieAnswerView({ a }: { a: GenieAnswer }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {a.mentioned_models.map((m) => <Pill key={m} variant="info">{m}</Pill>)}
        {a.risk_tier && <Pill variant="warn">Risk tier: {a.risk_tier}</Pill>}
      </div>
      <div className="max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-card-2 p-3.5 text-[12.5px] leading-[1.6]">{a.text || 'Genie returned no text.'}</div>
      {a.queries.map((q, i) => q.result && q.result.rows.length > 0 && (
        <div key={i} className="overflow-x-auto rounded-lg border border-line">
          {q.title && <div className="px-3 pt-2 text-[12px] font-medium">{q.title}</div>}
          <table className="tbl">
            <thead><tr>{q.result.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{q.result.rows.map((r, j) => <tr key={j}>{r.map((v, k) => <td key={k} className="num text-[12px]">{v ?? DASH}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Tracker
const STATUS_FILTERS = [
  { id: 'all', label: 'All' }, { id: 'submitted', label: 'Submitted' }, { id: 'info_requested', label: 'Info requested' },
  { id: 'approved', label: 'Approved' }, { id: 'rejected', label: 'Rejected' }, { id: 'deployed', label: 'Deployed' },
];

function Tracker({ list, me, catalog }: {
  list: Async<{ isGovernance: boolean; requests: IntakeRequest[] }>; me: Me | null; catalog: Async<CatalogData>;
}) {
  const nav = useNav();
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: 'pass' | 'warn' | 'fail'; text: string } | null>(null);
  const isGov = !!list.data?.isGovernance;
  const rows = list.data?.requests ?? [];
  const ucName = (id: string | null) => catalog.data?.useCases.find((u) => u.use_case_id === id)?.display_name ?? id;
  const visible = useMemo(() => rows.filter((r) =>
    (status === 'all' || r.status === status) &&
    (!q.trim() || [r.project, r.chosen_model, r.requested_by, r.use_case_type, r.cost_centre].join(' ').toLowerCase().includes(q.trim().toLowerCase())),
  ), [rows, status, q]);
  const deployReq = rows.find((r) => r.request_id === nav.deployFor) ?? null;

  if (list.error) return <ErrorNote message={list.error} onRetry={list.reload} />;
  if (!list.data) return <Card><LoadingBlock rows={6} /></Card>;

  return (
    <div className="flex flex-col gap-4">
      {flash && (
        <div className="flex items-start gap-3">
          <div className="flex-1"><Notice tone={flash.tone}>{flash.text}</Notice></div>
          <button className="pt-2 text-[12px] text-ink-3 hover:text-ink" onClick={() => setFlash(null)}>Dismiss</button>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((f) => {
            const n = f.id === 'all' ? rows.length : rows.filter((r) => r.status === f.id).length;
            return (
              <button key={f.id} onClick={() => setStatus(f.id)} aria-pressed={status === f.id}
                className={cx('rounded-pill px-3 py-1 text-[12px] font-medium', status === f.id ? 'bg-ink text-white' : 'bg-card text-ink-2 shadow-lift hover:bg-paper-2')}>
                {f.label} <span className="num opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <div className="w-[240px]"><SearchField value={q} onChange={setQ} placeholder="Search requests" /></div>
          <GhostButton size="sm" onClick={list.reload}>Refresh</GhostButton>
        </div>
      </div>

      {!rows.length ? (
        <Card>
          <EmptyState
            title={isGov ? 'No intake requests yet' : 'You have no requests yet'}
            body="Requests submitted from the New request tab appear here."
            action={<DarkButton size="sm" onClick={() => nav.go({ intakeTab: 'new' })}>New request</DarkButton>}
          />
        </Card>
      ) : !visible.length ? (
        <Card><EmptyState title="No requests match" action={<GhostButton size="sm" onClick={() => { setStatus('all'); setQ(''); }}>Clear filters</GhostButton>} /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Submitted</th><th>Project</th><th>Use case</th><th>Model</th><th>Env</th>
                {isGov && <th>Requested by</th>}
                <th>Risk tier</th><th>Status</th><th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const open = openId === r.request_id;
                const mine = !!me?.email && r.requested_by?.toLowerCase() === me.email.toLowerCase();
                const decidable = isGov && (r.status === 'submitted' || r.status === 'info_requested');
                return (
                  <RowGroup key={r.request_id}>
                    <tr className={cx('cursor-pointer', open && '[&>td]:bg-card-2')} onClick={() => setOpenId(open ? null : r.request_id)}>
                      <td className="whitespace-nowrap">{formatDateTime(r.created_at)}</td>
                      <td className="font-medium">{r.project}</td>
                      <td>{r.use_case_type || ucName(r.use_case_id) || DASH}</td>
                      <td className="num text-[12px]">{r.chosen_model}</td>
                      <td><Pill variant={r.environment === 'Prod' ? 'fail' : 'info'}>{r.environment || 'Lab'}</Pill></td>
                      {isGov && <td className="text-ink-2">{r.requested_by}</td>}
                      <td>{r.confirmed_risk_tier ? <Pill variant="pass">{titleCase(r.confirmed_risk_tier)}</Pill> : r.proposed_risk_tier ? <Pill variant="neutral" title="Proposed">{titleCase(r.proposed_risk_tier)} (proposed)</Pill> : DASH}</td>
                      <td><RequestStatusBadge status={r.status} /></td>
                      <td className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-1.5">
                          {decidable && <GhostButton size="sm" onClick={() => setOpenId(r.request_id)}>Review</GhostButton>}
                          {mine && r.status === 'info_requested' && <GhostButton size="sm" onClick={() => setOpenId(r.request_id)}>Respond</GhostButton>}
                          {r.status === 'approved' && <DarkButton size="sm" onClick={() => nav.go({ deployFor: r.request_id })}>Deploy</DarkButton>}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={isGov ? 9 : 8} className="bg-card-2">
                          <RequestDetail r={r} ucName={ucName} />
                          {decidable && <DecisionPanel r={r} onDone={(f) => { setFlash(f); setOpenId(null); notifyIntakeChanged(); catalog.reload(); }} />}
                          {mine && r.status === 'info_requested' && <RespondPanel r={r} onDone={(f) => { setFlash(f); setOpenId(null); notifyIntakeChanged(); }} />}
                        </td>
                      </tr>
                    )}
                  </RowGroup>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <DeployDrawer req={deployReq} onClose={() => nav.go({ deployFor: null })} />
    </div>
  );
}

function RowGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function RequestDetail({ r, ucName }: { r: IntakeRequest; ucName: (id: string | null) => string | null }) {
  const v = (s: string | null | undefined) => (s && s.trim() ? s : DASH);
  return (
    <div className="grid grid-cols-1 gap-5 py-2 lg:grid-cols-2">
      <KeyValues rows={[
        ['Request id', <span key="i" className="num text-[12px]">{r.request_id}</span>],
        ['Requested by', v(r.requested_by)],
        ['Cost centre', v(r.cost_centre)],
        ['Benchmarked use case', v(ucName(r.use_case_id))],
        ['Business objective', v(r.business_objective)],
        ['Expected outcome', v(r.expected_outcome)],
        ['Input data source', v(r.input_data_source)],
        ['Input format', v(r.input_format)],
        ['Input volume', v(r.input_volume)],
        ['Ground truth', v(r.ground_truth_availability)],
        ['Quality criteria', v(r.quality_criteria)],
        ['Latency', v(r.latency_requirement)],
        ['Cost sensitivity', v(r.cost_sensitivity)],
        ['Regulatory', v(r.regulatory_considerations)],
        ['Shortlisted', r.shortlisted_models?.length ? r.shortlisted_models.join(', ') : DASH],
      ]} />
      <div className="flex flex-col gap-3">
        <div>
          <div className="eyebrow mb-1.5">Genie recommendation</div>
          <div className="max-h-[300px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-card p-3 text-[12.5px] leading-[1.6]">
            {r.genie_recommendation || 'No recommendation was recorded.'}
          </div>
        </div>
        {(r.decision_by || r.decision_comment) && (
          <div>
            <div className="eyebrow mb-1.5">Decision</div>
            <div className="rounded-lg bg-card p-3 text-[12.5px]">
              {r.decision_by && <div className="mb-1 text-ink-2">{r.decision_by} · {formatDateTime(r.decided_at)}</div>}
              <div className="whitespace-pre-wrap">{r.decision_comment || DASH}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type Flash = { tone: 'pass' | 'warn' | 'fail'; text: string };

function DecisionPanel({ r, onDone }: { r: IntakeRequest; onDone: (f: Flash) => void }) {
  const [action, setAction] = useState<'approve' | 'reject' | 'info'>('approve');
  const [tier, setTier] = useState(r.proposed_risk_tier || '');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsComment = action !== 'approve';
  const ok = action === 'approve' ? !!tier : !!comment.trim();

  const go = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api.decide(r.request_id, { action, risk_tier: action === 'approve' ? tier : null, comment });
      const label = { approve: 'approved', reject: 'rejected', info: 'sent back for more information' }[action];
      onDone(res.warning ? { tone: 'warn', text: res.warning } : { tone: 'pass', text: `Request for ${r.project} ${label}.${res.tag ? ` ${r.chosen_model} approved_use_cases = ${res.tag}.` : ''}` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg bg-card p-4">
      <div className="eyebrow mb-3">AI governance decision</div>
      <div className="mb-3 flex flex-wrap gap-1">
        {(['approve', 'info', 'reject'] as const).map((a) => (
          <button key={a} onClick={() => setAction(a)} aria-pressed={action === a}
            className={cx('rounded-pill px-3 py-1 text-[12px] font-medium', action === a
              ? a === 'approve' ? 'bg-pass text-white' : a === 'reject' ? 'bg-fail text-white' : 'bg-warn text-white'
              : 'bg-paper-2 text-ink-2 hover:text-ink')}>
            {{ approve: 'Approve', info: 'Request info', reject: 'Reject' }[a]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_1fr]">
        {action === 'approve' && (
          <Field label="Confirmed risk tier" required>
            <Select value={tier} onChange={setTier} placeholder="Choose…" options={RISK} />
          </Field>
        )}
        <Field label={needsComment ? 'Comment (shared with the requester)' : 'Comment (optional)'} required={needsComment} className={action === 'approve' ? '' : 'md:col-span-2'}>
          <textarea className="input min-h-[60px]" value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </div>
      {action === 'approve' && r.use_case_id && (
        <div className="mt-2 text-[12px] text-ink-3">Approving also adds <span className="num">{r.use_case_id}</span> to the approved_use_cases tag on {r.chosen_model}.</div>
      )}
      {error && <div className="mt-3"><ErrorNote message={error} /></div>}
      <div className="mt-3 flex justify-end">
        <DarkButton size="sm" disabled={!ok || busy} onClick={go}>{busy ? 'Saving…' : 'Confirm'}</DarkButton>
      </div>
    </div>
  );
}

function RespondPanel({ r, onDone }: { r: IntakeRequest; onDone: (f: Flash) => void }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setError(null);
    try {
      await api.respond(r.request_id, reply);
      onDone({ tone: 'pass', text: 'Response sent. The request is back with AI governance.' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 rounded-lg bg-card p-4">
      <Field label="Your response to AI governance" required>
        <textarea className="input min-h-[70px]" value={reply} onChange={(e) => setReply(e.target.value)} />
      </Field>
      {error && <div className="mt-3"><ErrorNote message={error} /></div>}
      <div className="mt-3 flex justify-end">
        <DarkButton size="sm" disabled={!reply.trim() || busy} onClick={go}>{busy ? 'Sending…' : 'Send and resubmit'}</DarkButton>
      </div>
    </div>
  );
}
