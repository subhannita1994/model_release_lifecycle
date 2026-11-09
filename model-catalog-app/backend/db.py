"""Run SQL on the warehouse ON BEHALF OF THE SIGNED-IN USER.

Databricks Apps forwards the user's OAuth token in x-forwarded-access-token when
on-behalf-of-user authorization is enabled. We build a WorkspaceClient with that
token (auth_type=pat so the app's own service-principal env vars are ignored)
and use the Statement Execution API with named parameters.
"""
import json
import os
import time

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import Disposition, Format, StatementParameterListItem, StatementState

WAREHOUSE_ID = os.environ.get("DATABRICKS_WAREHOUSE_ID", "fc56ed6708dfb7c1")
MAX_WAIT_S = 120


class QueryError(RuntimeError):
    pass


def _host() -> str:
    h = os.environ.get("DATABRICKS_HOST", "").strip().rstrip("/")
    return h if h.startswith("http") else f"https://{h}"


def user_client(token: str | None) -> WorkspaceClient:
    if not token:
        raise PermissionError(
            "No user token was forwarded. Enable on-behalf-of-user authorization for this app "
            "(user API scopes: sql, dashboards.genie) and reload."
        )
    return WorkspaceClient(host=_host(), token=token, auth_type="pat")


def _param(name: str, value) -> StatementParameterListItem:
    if value is None:
        return StatementParameterListItem(name=name, type="STRING")
    if isinstance(value, bool):
        return StatementParameterListItem(name=name, value="true" if value else "false", type="BOOLEAN")
    if isinstance(value, int):
        return StatementParameterListItem(name=name, value=str(value), type="INT")
    if isinstance(value, float):
        return StatementParameterListItem(name=name, value=repr(value), type="DOUBLE")
    return StatementParameterListItem(name=name, value=str(value), type="STRING")


_INT = {"BYTE", "SHORT", "INT", "LONG"}
_FLOAT = {"FLOAT", "DOUBLE", "DECIMAL"}
_JSON = {"ARRAY", "MAP", "STRUCT"}


def _convert(value, type_name: str):
    if value is None:
        return None
    if type_name in _INT:
        return int(value)
    if type_name in _FLOAT:
        return float(value)
    if type_name == "BOOLEAN":
        return value in (True, "true", "True", "1")
    if type_name in _JSON:
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return value
    return value


def query(token: str | None, statement: str, params: dict | None = None) -> list[dict]:
    """Execute one statement as the user and return rows as dicts (typed)."""
    w = user_client(token)
    items = [_param(k, v) for k, v in (params or {}).items()]
    resp = w.statement_execution.execute_statement(
        statement=statement,
        warehouse_id=WAREHOUSE_ID,
        parameters=items or None,
        wait_timeout="30s",
        disposition=Disposition.INLINE,
        format=Format.JSON_ARRAY,
    )
    deadline = time.time() + MAX_WAIT_S
    while resp.status and resp.status.state in (StatementState.PENDING, StatementState.RUNNING):
        if time.time() > deadline:
            w.statement_execution.cancel_execution(resp.statement_id)
            raise QueryError("The SQL warehouse took too long to answer. Try again in a moment.")
        time.sleep(1)
        resp = w.statement_execution.get_statement(resp.statement_id)
    state = resp.status.state if resp.status else None
    if state != StatementState.SUCCEEDED:
        msg = resp.status.error.message if resp.status and resp.status.error else f"statement {state}"
        raise QueryError(msg)
    if not resp.manifest or not resp.manifest.schema or not resp.manifest.schema.columns:
        return []
    cols = [(c.name, c.type_name.value if c.type_name else "STRING") for c in resp.manifest.schema.columns]
    rows = list((resp.result.data_array if resp.result else None) or [])
    nxt = resp.result.next_chunk_index if resp.result else None
    while nxt is not None:
        chunk = w.statement_execution.get_statement_result_chunk_n(resp.statement_id, nxt)
        rows.extend(chunk.data_array or [])
        nxt = chunk.next_chunk_index
    return [{name: _convert(v, t) for (name, t), v in zip(cols, row)} for row in rows]


def affected_rows(rows: list[dict]) -> int:
    """num_affected_rows from a DML result (0 when absent)."""
    if not rows:
        return 0
    return int(rows[0].get("num_affected_rows") or rows[0].get("num_inserted_rows") or 0)
