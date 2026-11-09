# Model Catalog app

Databricks App for the Co-operators model catalog: **Browse > Inspect > Compare > Intake > Sign-off > Deploy**.
React + Vite + Tailwind frontend, FastAPI backend. Theme and shell copied from the Intelligent AI FinOps framework.

## Layout

| Path | What |
| --- | --- |
| `src/theme.css` | **The only theme file**: colours, fonts, radii, shadows, chart series, brand text |
| `src/components/primitives.tsx` | Card, Pill/badges, buttons, Figure/KPI, inputs, Tabs, Drawer, empty/loading/error states |
| `src/components/charts.tsx` | Bar list, grouped bars, columns (no chart library) |
| `src/pages/*` | Catalog, ModelDetails, Compare, Intake (new request + tracker), DeployDrawer (scaffold) |
| `src/store.ts` | Journey state (selected models + use case), mirrored to the URL hash |
| `backend/sql.py` | **Every SQL statement** the app runs |
| `backend/db.py` | On-behalf-of-user Statement Execution client (warehouse `test_arc_1`) |
| `backend/genie.py` | Genie Conversation API client (Model Selection Advisor) |
| `backend/tags.py` | Adds the use case to the model service's `approved_use_cases` tag on approval |

## Data

Reads `serverless_nv91sa_catalog.model_catalog`: `model_services`, `use_case_config`, `v_latest_results`,
`benchmark_results`, `benchmark_examples`, `mc_*_payload` inference tables, `intake_requests`.
Writes **only** `intake_requests` (insert on submit, update on decision / response).

## Auth and governance

* All calls run as the signed-in user (`x-forwarded-access-token`). Required user API scopes: `sql`, `dashboards.genie`.
  Users need SELECT on the schema, MODIFY on `intake_requests`, CAN USE on the warehouse and access to the Genie agent.
* AI governance = emails in `GOVERNANCE_USERS` (app.yaml). They see all requests and can Approve / Reject / Request info.
  Everyone else sees only their own requests. This split is enforced by the app, not by table permissions.
* Approval also tags the model service (`approved_use_cases`). If a governed tag policy blocks the value, the approval
  still stands and the app shows a warning; the catalog's "Approved for" filter also reads approved intake rows.
* Notifications are in-app only (badge on the Intake tab).

## Not in this phase

Deploy is a UI scaffold: no deployments table and no `model-catalog-deploy` job yet.

## Local dev

```bash
npm install && npm run dev          # http://localhost:5173 (proxies /api to :8000)
uvicorn backend.main:app --port 8000
```
