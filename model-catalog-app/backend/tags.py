"""Unity Catalog tag writes on model services.

Approval adds the use case to the model service's approved_use_cases tag
(comma-separated). The entity-tag-assignments API needs the `unity-catalog`
OAuth scope, which Databricks Apps can't request on behalf of users, so this one
write runs as the APP SERVICE PRINCIPAL. main.py only calls it after checking the
caller is in GOVERNANCE_USERS, and the approver is recorded in
intake_requests.decision_by. The SP needs APPLY TAG (plus USE CATALOG / USE
SCHEMA) on the model services. If the write fails, the approval still stands and
the catalog also reads approvals from intake_requests.
"""
from databricks.sdk import WorkspaceClient

TAG_API = "/api/2.1/unity-catalog/entity-tag-assignments"
ENTITY_TYPE = "model-services"
TAG_KEY = "approved_use_cases"


def _read(w, full_name: str) -> dict:
    out, token = {}, None
    while True:
        resp = w.api_client.do("GET", f"{TAG_API}/{ENTITY_TYPE}/{full_name}/tags",
                               query={"page_token": token} if token else None)
        out |= {t["tag_key"]: t.get("tag_value") for t in resp.get("tag_assignments", [])}
        token = resp.get("next_page_token")
        if not token:
            return out


def add_approved_use_case(full_name: str, use_case_id: str) -> str:
    """Returns the new tag value. Raises on failure (caller reports it as a warning)."""
    w = WorkspaceClient()  # app service principal (DATABRICKS_CLIENT_ID / SECRET injected by Apps)
    current = _read(w, full_name)
    existing = current.get(TAG_KEY)
    values = sorted({v.strip() for v in (existing or "").split(",") if v.strip()} | {use_case_id})
    value = ",".join(values)
    if existing is None:
        w.api_client.do("POST", TAG_API, body={"entity_type": ENTITY_TYPE, "entity_name": full_name,
                                               "tag_key": TAG_KEY, "tag_value": value})
    elif existing != value:
        w.api_client.do("PATCH", f"{TAG_API}/{ENTITY_TYPE}/{full_name}/tags/{TAG_KEY}",
                        query={"update_mask": "tag_value"}, body={"tag_value": value})
    return value
