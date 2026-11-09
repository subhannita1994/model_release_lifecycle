import { useEffect, useState } from 'react';
import type { IntakeRequest } from '../types';
import { DarkButton, Drawer, Field, GhostButton, KeyValues, Notice, Pill, cx } from '../components/primitives';
import { DASH, titleCase } from '../lib/format';

// Deploy wizard - UI scaffold only in this phase. Nothing is written and no job runs.
// Lab would trigger the model-catalog-deploy job; Prod would create a deployment
// request picked up by CI/CD (Declarative Automation Bundles).
type Step = 0 | 1 | 2 | 3;
const STEPS = ['Configure', 'Access', 'Tags', 'Review'];

const slug = (s: string | null | undefined) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function DeployDrawer({ req, onClose }: { req: IntakeRequest | null; onClose: () => void }) {
  const [step, setStep] = useState<Step>(0);
  const [endpoint, setEndpoint] = useState('');
  const [rateLimit, setRateLimit] = useState('60');
  const [budget, setBudget] = useState('');
  const [groups, setGroups] = useState('');
  const [principals, setPrincipals] = useState('');
  const [tags, setTags] = useState<[string, string][]>([]);

  useEffect(() => {
    if (!req) return;
    setStep(0);
    setEndpoint(`${slug(req.project)}-${slug(req.use_case_id || req.use_case_type) || 'model'}`.replace(/^-/, ''));
    setTags([
      ['project', req.project || ''],
      ['cost_centre', req.cost_centre || ''],
      ['use_case', req.use_case_id || req.use_case_type || ''],
      ['risk_tier', req.confirmed_risk_tier || req.proposed_risk_tier || ''],
      ['environment', (req.environment || 'Lab').toLowerCase()],
      ['intake_request_id', req.request_id],
    ]);
  }, [req]);

  if (!req) return null;
  const env = req.environment || 'Lab';

  const footer = (
    <div className="flex items-center justify-between gap-3">
      <GhostButton onClick={step === 0 ? onClose : () => setStep((step - 1) as Step)}>{step === 0 ? 'Cancel' : '← Back'}</GhostButton>
      {step < 3 ? (
        <DarkButton onClick={() => setStep((step + 1) as Step)}>Next →</DarkButton>
      ) : (
        <DarkButton disabled title="Deployment is not enabled in this phase">Deploy (not enabled yet)</DarkButton>
      )}
    </div>
  );

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Deploy ${req.chosen_model ?? ''}`}
      subtitle={<>{req.project} · {req.use_case_type || req.use_case_id} · <Pill variant={env === 'Prod' ? 'fail' : 'info'}>{env}</Pill></>}
      footer={footer}
    >
      <ol className="mb-5 flex gap-1" aria-label="Deploy steps">
        {STEPS.map((s, i) => (
          <li key={s} className="flex-1">
            <button
              onClick={() => setStep(i as Step)}
              className={cx('w-full rounded-pill px-2 py-1.5 text-[12px] font-medium',
                i === step ? 'bg-ink text-white' : i < step ? 'bg-paper-2 text-ink' : 'text-ink-3 hover:bg-paper-2')}
            >
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>

      <div className="mb-4">
        <Notice tone="warn">Preview only. Deployment is not enabled in this phase, so nothing here is saved.</Notice>
      </div>

      {step === 0 && (
        <div className="flex flex-col gap-4">
          <Field label="Environment" hint="From the approved intake request."><div className="input bg-card-2">{env}</div></Field>
          <Field label="Model service"><div className="input bg-card-2">{req.chosen_model}</div></Field>
          <Field label="Endpoint name"><input className="input" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} /></Field>
          <Field label="Rate limit (requests / minute)"><input className="input num" inputMode="numeric" value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} /></Field>
          <Field label="Monthly budget alert (USD)" hint="Optional"><input className="input num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 500" /></Field>
        </div>
      )}
      {step === 1 && (
        <div className="flex flex-col gap-4">
          <Field label="Groups that can query" hint="Comma-separated account groups."><input className="input" value={groups} onChange={(e) => setGroups(e.target.value)} placeholder="e.g. claims-analytics" /></Field>
          <Field label="Service principals" hint="Comma-separated application ids for jobs or apps."><input className="input" value={principals} onChange={(e) => setPrincipals(e.target.value)} /></Field>
        </div>
      )}
      {step === 2 && (
        <div className="flex flex-col gap-2">
          {tags.map(([k, v], i) => (
            <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
              <input className="input num text-[12px]" value={k} onChange={(e) => setTags(tags.map((t, j) => (j === i ? [e.target.value, t[1]] : t)))} aria-label="Tag key" />
              <input className="input" value={v} onChange={(e) => setTags(tags.map((t, j) => (j === i ? [t[0], e.target.value] : t)))} aria-label="Tag value" />
              <button className="px-2 text-ink-3 hover:text-fail" onClick={() => setTags(tags.filter((_, j) => j !== i))} aria-label="Remove tag">×</button>
            </div>
          ))}
          <GhostButton size="sm" className="self-start" onClick={() => setTags([...tags, ['', '']])}>+ Add tag</GhostButton>
        </div>
      )}
      {step === 3 && (
        <div className="flex flex-col gap-4">
          <KeyValues rows={[
            ['Environment', env],
            ['Model service', req.chosen_model ?? DASH],
            ['Endpoint', endpoint || DASH],
            ['Rate limit', rateLimit ? `${rateLimit} / min` : DASH],
            ['Budget alert', budget ? `$${budget} / month` : DASH],
            ['Groups', groups || DASH],
            ['Service principals', principals || DASH],
            ['Risk tier', titleCase(req.confirmed_risk_tier || req.proposed_risk_tier)],
            ['Tags', tags.filter(([k]) => k).map(([k, v]) => `${k}=${v}`).join(', ') || DASH],
          ]} />
          <Notice tone="info">
            {env === 'Prod'
              ? 'When enabled, this creates a deployment request that CI/CD (Declarative Automation Bundles) picks up for promotion to production.'
              : 'When enabled, this starts the model-catalog-deploy job to create the endpoint in the Lab workspace.'}
          </Notice>
        </div>
      )}
    </Drawer>
  );
}
