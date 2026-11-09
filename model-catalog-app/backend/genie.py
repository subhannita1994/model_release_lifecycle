"""Genie Conversation API client (as the signed-in user).

The intake form is sent to the Genie agent; the browser then polls for the answer
so no HTTP request has to stay open while Genie thinks.
"""
import os
import re

from . import db

SPACE_ID = os.environ.get("GENIE_SPACE_ID", "01f1da09d0a91719ba75b4a3b2d4bdb9")
_BASE = f"/api/2.0/genie/spaces/{SPACE_ID}"
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "QUERY_RESULT_EXPIRED"}
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_RISK = re.compile(r"risk[\s_-]*tier[^A-Za-z]{0,40}(low|medium|high)", re.I)
_MODEL = re.compile(r"\bmc-[a-z0-9][a-z0-9-]*[a-z0-9]\b")

FORM_LABELS = [
    ("project", "Project"),
    ("environment", "Environment"),
    ("cost_centre", "Cost centre"),
    ("use_case_type", "Use case type"),
    ("use_case_id", "Benchmarked use case id"),
    ("business_objective", "Business objective"),
    ("input_data_source", "Input data source"),
    ("input_format", "Input format"),
    ("input_volume", "Input volume"),
    ("expected_outcome", "Expected outcome"),
    ("quality_criteria", "Quality criteria"),
    ("latency_requirement", "Latency requirement"),
    ("cost_sensitivity", "Cost sensitivity"),
    ("ground_truth_availability", "Ground-truth availability"),
    ("regulatory_considerations", "Regulatory considerations"),
]


def build_prompt(form: dict) -> str:
    lines = ["A project team is requesting an AI model for a new use case. Their intake answers:"]
    for key, label in FORM_LABELS:
        val = (form.get(key) or "").strip() if isinstance(form.get(key), str) else form.get(key)
        if val:
            lines.append(f"- {label}: {val}")
    shortlist = form.get("shortlisted_models") or []
    lines.append(f"- Shortlisted model services: {', '.join(shortlist) if shortlist else 'none yet'}")
    lines.append(
        "\nRecommend the best model service (use the mc-* service names) for this request using the "
        "benchmark results, thresholds and costs in the catalog. Compare the shortlisted models if any, "
        "explain the trade-offs (quality, latency, cost, licence, data residency), and state a proposed "
        "risk tier as 'Risk tier: low', 'Risk tier: medium' or 'Risk tier: high'."
    )
    return "\n".join(lines)


def ask(token: str | None, form: dict) -> dict:
    w = db.user_client(token)
    r = w.api_client.do("POST", f"{_BASE}/start-conversation", body={"content": build_prompt(form)})
    conv = r.get("conversation_id") or (r.get("conversation") or {}).get("id")
    msg = r.get("message_id") or (r.get("message") or {}).get("id")
    return {"conversation_id": conv, "message_id": msg, "space_id": SPACE_ID}


def _query_result(w, conv: str, msg: str, attachment_id: str) -> dict | None:
    try:
        r = w.api_client.do("GET", f"{_BASE}/conversations/{conv}/messages/{msg}/attachments/{attachment_id}/query-result")
    except Exception:  # noqa: BLE001 - results are optional decoration
        return None
    sr = r.get("statement_response") or {}
    cols = [c.get("name") for c in ((sr.get("manifest") or {}).get("schema") or {}).get("columns", [])]
    rows = ((sr.get("result") or {}).get("data_array") or [])[:25]
    return {"columns": cols, "rows": rows}


def message(token: str | None, conv: str, msg: str) -> dict:
    if not (_ID.match(conv or "") and _ID.match(msg or "")):
        raise ValueError("invalid Genie conversation or message id")
    w = db.user_client(token)
    m = w.api_client.do("GET", f"{_BASE}/conversations/{conv}/messages/{msg}")
    status = m.get("status") or "SUBMITTED"
    err = m.get("error")
    out = {"status": status, "done": status in TERMINAL, "text": "", "queries": [],
           "error": (err.get("error") if isinstance(err, dict) else err) or None,
           "risk_tier": None, "mentioned_models": []}
    if status != "COMPLETED":
        return out
    texts = []
    for a in m.get("attachments") or []:
        if a.get("text"):
            texts.append(a["text"].get("content") or "")
        if a.get("query"):
            q = a["query"]
            res = _query_result(w, conv, msg, a.get("attachment_id") or a.get("id") or "")
            out["queries"].append({"title": q.get("title"), "description": q.get("description"),
                                   "result": res})
            if q.get("description"):
                texts.append(q["description"])
    out["text"] = "\n\n".join(t for t in texts if t).strip()
    mt = _RISK.search(out["text"])
    out["risk_tier"] = mt.group(1).lower() if mt else None
    out["mentioned_models"] = list(dict.fromkeys(_MODEL.findall(out["text"])))
    return out
