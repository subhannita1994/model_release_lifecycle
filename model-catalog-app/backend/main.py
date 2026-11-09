"""FastAPI app for the Co-operators Model Catalog.

Serves the built React frontend (./dist) and exposes /api. Every data call runs
as the signed-in user (on-behalf-of-user token). All SQL lives in sql.py; the only
table written is intake_requests. Deployments are a UI scaffold in this phase.
"""
import json
import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db, genie, sql, tags

app = FastAPI(title="Model Catalog")

GOVERNANCE_USERS = {u.strip().lower() for u in os.environ.get("GOVERNANCE_USERS", "subhannita.sarcar@databricks.com").split(",") if u.strip()}
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
USE_CASE_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
RECORD_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
PAYLOAD_RE = re.compile(rf"^{re.escape(sql.S)}\.mc_[a-z0-9_]+_payload$")
RISK_TIERS = {"low", "medium", "high"}
ENVIRONMENTS = {"Lab", "Prod"}


# ------------------------------------------------------------------ helpers
def _token(request: Request) -> str | None:
    return request.headers.get("x-forwarded-access-token")


def _email(request: Request) -> str:
    return (request.headers.get("x-forwarded-email") or request.headers.get("x-forwarded-preferred-username") or "").lower()


def _is_gov(request: Request) -> bool:
    return _email(request) in GOVERNANCE_USERS


def _name(value: str) -> str:
    if not NAME_RE.match(value or ""):
        raise HTTPException(400, f"invalid model service name: {value!r}")
    return value


def _names(csv: str, lo: int = 1, hi: int = 6) -> list[str]:
    names = list(dict.fromkeys(_name(n.strip()) for n in (csv or "").split(",") if n.strip()))
    if not lo <= len(names) <= hi:
        raise HTTPException(400, f"select between {lo} and {hi} model services")
    return names


def _use_case(value: str | None, required: bool = False) -> str | None:
    if not value:
        if required:
            raise HTTPException(400, "use_case is required")
        return None
    if not USE_CASE_RE.match(value):
        raise HTTPException(400, f"invalid use case: {value!r}")
    return value


def _use_cases(token):
    rows = db.query(token, sql.USE_CASES)
    for r in rows:
        r["thresholds"] = json.loads(r.pop("thresholds_json") or "{}")
    return rows


@app.exception_handler(PermissionError)
def _perm(_: Request, exc: PermissionError):
    return JSONResponse({"error": str(exc)}, status_code=403)


@app.exception_handler(db.QueryError)
def _query_err(_: Request, exc: db.QueryError):
    msg = str(exc)
    status = 403 if ("PERMISSION" in msg.upper() or "INSUFFICIENT" in msg.upper()) else 502
    return JSONResponse({"error": msg[:600]}, status_code=status)


@app.exception_handler(ValueError)
def _value_err(_: Request, exc: ValueError):
    return JSONResponse({"error": str(exc)[:400]}, status_code=400)


@app.exception_handler(HTTPException)
def _http_err(_: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.exception_handler(Exception)
def _any_err(_: Request, exc: Exception):
    return JSONResponse({"error": f"{type(exc).__name__}: {str(exc)[:500]}"}, status_code=500)


# ------------------------------------------------------------------ identity
@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    return {"email": _email(request), "isGovernance": _is_gov(request), "hasUserToken": bool(_token(request))}


# ------------------------------------------------------------------ catalog
@app.get("/api/catalog")
def catalog(request: Request):
    """Everything the Catalog page and journey bar need: use cases, models, latest benchmark summary."""
    t = _token(request)
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_uc = ex.submit(_use_cases, t)
        f_models = ex.submit(db.query, t, sql.MODELS, {"model": None})
        f_sum = ex.submit(db.query, t, sql.BENCH_SUMMARY, {"model": None})
        return {"useCases": f_uc.result(), "models": f_models.result(), "summary": f_sum.result()}


@app.get("/api/models/{name}")
def model_detail(name: str, request: Request):
    t = _token(request)
    name = _name(name)
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_m = ex.submit(db.query, t, sql.MODELS, {"model": name})
        f_s = ex.submit(db.query, t, sql.BENCH_SUMMARY, {"model": name})
        f_uc = ex.submit(_use_cases, t)
        rows = f_m.result()
        if not rows:
            raise HTTPException(404, f"model service {name} not found or inactive")
        return {"model": rows[0], "summary": f_s.result(), "useCases": f_uc.result()}


@app.get("/api/models/{name}/history")
def model_history(name: str, request: Request):
    t, name = _token(request), _name(name)
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_runs = ex.submit(db.query, t, sql.MODEL_RUN_HISTORY, {"model": name})
        f_req = ex.submit(db.query, t, sql.INTAKE_LIST, {"is_gov": _is_gov(request), "request_id": None, "model": name})
        return {"runs": f_runs.result(), "requests": f_req.result()}


@app.get("/api/models/{name}/usage")
def model_usage(name: str, request: Request):
    t, name = _token(request), _name(name)
    rows = db.query(t, sql.MODELS, {"model": name})
    if not rows:
        raise HTTPException(404, f"model service {name} not found")
    tbl = rows[0].get("inference_table")
    if not tbl or not PAYLOAD_RE.match(tbl):
        return {"inferenceTable": tbl, "days": [], "note": "No inference table is configured for this service."}
    return {"inferenceTable": tbl, "days": db.query(t, sql.MODEL_USAGE, {"tbl": tbl})}


@app.get("/api/metrics")
def metrics(request: Request, models: str, use_case: str | None = None):
    names = _names(models, 1, 6)
    return db.query(_token(request), sql.METRICS, {"models": json.dumps(names), "use_case": _use_case(use_case)})


@app.get("/api/examples/records")
def example_records(request: Request, models: str, use_case: str):
    names = _names(models, 1, 6)
    return db.query(_token(request), sql.EXAMPLE_RECORD_IDS,
                    {"models": json.dumps(names), "use_case": _use_case(use_case, True)})


@app.get("/api/examples")
def examples(request: Request, models: str, use_case: str, record_id: str | None = None, limit: int = 10):
    names = _names(models, 1, 6)
    if record_id is not None and not RECORD_RE.match(record_id):
        raise HTTPException(400, "invalid record id")
    stmt = sql.EXAMPLES.replace("{limit}", str(max(1, min(int(limit), 60))))
    return db.query(_token(request), stmt, {"models": json.dumps(names), "use_case": _use_case(use_case, True),
                                            "record_id": record_id})


# ------------------------------------------------------------------ Genie
class IntakeForm(BaseModel):
    project: str = Field("", max_length=200)
    environment: str = Field("Lab", max_length=20)
    cost_centre: str = Field("", max_length=100)
    use_case_type: str = Field("", max_length=200)
    use_case_id: str | None = None
    business_objective: str = Field("", max_length=4000)
    input_data_source: str = Field("", max_length=2000)
    input_format: str = Field("", max_length=1000)
    input_volume: str = Field("", max_length=500)
    expected_outcome: str = Field("", max_length=4000)
    quality_criteria: str = Field("", max_length=4000)
    latency_requirement: str = Field("", max_length=500)
    cost_sensitivity: str = Field("", max_length=500)
    ground_truth_availability: str = Field("", max_length=1000)
    regulatory_considerations: str = Field("", max_length=4000)
    shortlisted_models: list[str] = Field(default_factory=list, max_length=6)


class IntakeIn(IntakeForm):
    chosen_model: str
    proposed_risk_tier: str | None = None
    genie_conversation_id: str | None = None
    genie_message_id: str | None = None
    genie_recommendation: str | None = Field(None, max_length=20000)


def _blank_to_none(v):
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def _validate_form(form: IntakeForm):
    if not form.project.strip():
        raise HTTPException(400, "Project is required")
    if not form.business_objective.strip():
        raise HTTPException(400, "Business objective is required")
    if form.environment not in ENVIRONMENTS:
        raise HTTPException(400, f"environment must be one of {sorted(ENVIRONMENTS)}")
    _use_case(form.use_case_id)
    for n in form.shortlisted_models:
        _name(n)


@app.post("/api/genie/ask")
def genie_ask(body: IntakeForm, request: Request):
    _validate_form(body)
    return genie.ask(_token(request), body.model_dump())


@app.get("/api/genie/{conversation_id}/{message_id}")
def genie_message(conversation_id: str, message_id: str, request: Request):
    return genie.message(_token(request), conversation_id, message_id)


# ------------------------------------------------------------------ intake_requests
@app.get("/api/intake")
def intake_list(request: Request):
    rows = db.query(_token(request), sql.INTAKE_LIST, {"is_gov": _is_gov(request), "request_id": None, "model": None})
    return {"isGovernance": _is_gov(request), "requests": rows}


@app.post("/api/intake")
def intake_create(body: IntakeIn, request: Request):
    _validate_form(body)
    _name(body.chosen_model)
    if body.proposed_risk_tier and body.proposed_risk_tier not in RISK_TIERS:
        raise HTTPException(400, "proposed risk tier must be low, medium or high")
    request_id = str(uuid.uuid4())
    p = body.model_dump()
    p["shortlisted_models"] = json.dumps(body.shortlisted_models)
    p["request_id"] = request_id
    p = {k: _blank_to_none(v) for k, v in p.items()}
    db.query(_token(request), sql.INTAKE_INSERT, p)
    # In-app notification only (phase 1): governance sees the new request in the tracker badge.
    return {"request_id": request_id, "status": "submitted"}


class DecisionIn(BaseModel):
    action: Literal["approve", "reject", "info"]
    risk_tier: str | None = None
    comment: str = Field("", max_length=4000)


@app.post("/api/intake/{request_id}/decision")
def intake_decide(request_id: str, body: DecisionIn, request: Request):
    if not _is_gov(request):
        raise HTTPException(403, "Only AI governance can approve, reject or request information.")
    uuid.UUID(request_id)
    t = _token(request)
    status = {"approve": "approved", "reject": "rejected", "info": "info_requested"}[body.action]
    if body.action == "approve" and body.risk_tier not in RISK_TIERS:
        raise HTTPException(400, "Confirm a risk tier (low, medium or high) to approve.")
    if body.action in ("reject", "info") and not body.comment.strip():
        raise HTTPException(400, "Add a comment explaining the decision.")
    res = db.query(t, sql.INTAKE_DECIDE, {"status": status, "risk_tier": body.risk_tier,
                                          "comment": body.comment.strip() or None, "request_id": request_id})
    if db.affected_rows(res) == 0:
        raise HTTPException(409, "This request is no longer awaiting a decision (refresh the tracker).")
    warning, tag_value = None, None
    if status == "approved":
        req = db.query(t, sql.INTAKE_LIST, {"is_gov": True, "request_id": request_id, "model": None})
        r = req[0] if req else {}
        if r.get("use_case_id") and r.get("chosen_model"):
            m = db.query(t, sql.MODELS, {"model": r["chosen_model"]})
            try:
                if not m:
                    raise RuntimeError(f"model service {r['chosen_model']} not found")
                tag_value = tags.add_approved_use_case(m[0]["full_name"], r["use_case_id"])
            except Exception as e:  # noqa: BLE001 - approval stands; surface the tag problem
                warning = (f"Approved, but the approved_use_cases tag on {r['chosen_model']} could not be "
                           f"updated: {str(e)[:300]}")
        else:
            warning = "Approved. No benchmarked use case on this request, so no approved_use_cases tag was added."
    return {"request_id": request_id, "status": status, "tag": tag_value, "warning": warning}


class RespondIn(BaseModel):
    reply: str = Field(..., min_length=1, max_length=4000)


@app.post("/api/intake/{request_id}/respond")
def intake_respond(request_id: str, body: RespondIn, request: Request):
    uuid.UUID(request_id)
    res = db.query(_token(request), sql.INTAKE_RESPOND, {"reply": body.reply.strip(), "request_id": request_id})
    if db.affected_rows(res) == 0:
        raise HTTPException(409, "Only the requester can respond, and only while information is requested.")
    return {"request_id": request_id, "status": "submitted"}


# ------------------------------------------------------------------ frontend (SPA)
_DIST = Path(__file__).resolve().parent.parent / "dist"
if (_DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")


@app.get("/{full_path:path}")
def spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(404, "not found")
    candidate = (_DIST / full_path).resolve()
    if full_path and candidate.is_file() and _DIST in candidate.parents:
        return FileResponse(candidate)
    index = _DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    return JSONResponse({"error": "Frontend not built (npm run build)."}, status_code=503)
