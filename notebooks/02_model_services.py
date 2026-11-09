# Databricks notebook source
# DBTITLE 1,Overview
# MAGIC %md
# MAGIC # 02_model_services
# MAGIC
# MAGIC Creates Unity Gateway model services `mc-<model>` in `serverless_nv91sa_catalog.model_catalog` for the benchmark candidates, with usage tracking, inference logging and governance tags, and maintains the `model_services` catalog table via `refresh_model_services()`.
# MAGIC
# MAGIC Step 1 only discovers which `system.ai` chat models are callable in this workspace; nothing is created there.
# MAGIC
# MAGIC * **Re-runnable:** services are created only if missing, otherwise patched only where routing, inference logging or comment differ. Tags are written only when they differ; `status` is set once and never reset (governance owns it after creation).
# MAGIC * **Usage tracking:** Unity Gateway records every request to these services in `system.ai_gateway.usage` automatically; there is no per-service switch. **Inference logging:** each service writes payloads to `model_catalog.<service>_payload`.
# MAGIC * **Prices:** edit the DBU rates in `MODEL_PRICES` (cell 2). Each refresh multiplies them by the current $/DBU of the provider's `ENTERPRISE_<PROVIDER>_MODEL_SERVING` SKU in `system.billing.list_prices` to get `usd_per_1m_*`. `price_source` is `list_price` only when both DBU rates are set and a current list price exists, otherwise `placeholder`; the refresh prints a warning listing placeholder models.
# MAGIC * **Job:** `model-catalog-benchmark` runs this notebook with `run_mode=refresh` as its first task (`refresh_model_services`), nightly at 02:00 America/Toronto.
# MAGIC * **Known blocker:** the account-level governed tag policy on `owner` only allows `retail_team, lending_team, payments_team, wealth_team, risk_team`, so `owner=ai-governance` is rejected until an account admin adds that value. Then re-run cell 4.

# COMMAND ----------

# DBTITLE 1,1. Discover available models (read-only)
from databricks.sdk import WorkspaceClient
import pandas as pd

w = WorkspaceClient()


def list_model_services(parent: str) -> list[dict]:
    """List all Unity Gateway model services under a schema (handles pagination)."""
    out, token = [], None
    while True:
        q = {"parent": f"schemas/{parent}"}
        if token:
            q["page_token"] = token
        resp = w.api_client.do("GET", "/api/2.1/unity-catalog/model-services", query=q)
        out += resp.get("model_services", [])
        token = resp.get("next_page_token")
        if not token:
            return out


def _blocked(cfg: dict) -> bool:
    """True when a service-level rate limit of 0 denies all calls."""
    return any(rl.get("key") == "RATE_LIMIT_KEY_SERVICE" and (rl.get("requests") == "0" or rl.get("tokens") == "0")
               for rl in cfg.get("rate_limits", []))


system_models = list_model_services("system.ai")
available = pd.DataFrame([{
    "model": s["name"].split("system.ai.")[-1],
    "chat": "mlflow/v1/chat/completions" in s.get("supported_api_types", []),
    "reasoning": s.get("capabilities", {}).get("reasoning", False),
    "function_calling": s.get("capabilities", {}).get("function_calling", False),
    "image_input": s.get("capabilities", {}).get("image_input", False),
    "blocked_by_rate_limit": _blocked(s.get("config", {})),
    "created": s.get("create_time", "")[:10],
} for s in system_models]).sort_values("model").reset_index(drop=True)

print(f"{len(available)} system.ai services; {int(available.chat.sum())} support chat completions; "
      f"{int(available.blocked_by_rate_limit.sum())} blocked by a zero service rate limit")
display(available[available.chat])

# COMMAND ----------

# DBTITLE 1,2. Configuration: models, tags and editable price dictionary
# Job parameter: 'setup' (default) creates/updates services then refreshes the table;
# 'refresh' only runs refresh_model_services() (used by the nightly model-catalog-benchmark job).
dbutils.widgets.dropdown("run_mode", "setup", ["setup", "refresh"])
RUN_MODE = dbutils.widgets.get("run_mode")

CATALOG = "serverless_nv91sa_catalog"
SCHEMA = "model_catalog"
PARENT = f"{CATALOG}.{SCHEMA}"
SERVICE_PREFIX = "mc-"
MODEL_SERVICES_TABLE = f"{PARENT}.model_services"

# ---------------------------------------------------------------------------
# PRICE DICTIONARY (edit me). DBUs per 1M tokens, keyed by service name.
# PLACEHOLDER (None) = not yet confirmed -> price_source 'placeholder', USD null.
# USD = DBU rate x current $/DBU from system.billing.list_prices for the
# provider's <TIER>_<PROVIDER>_MODEL_SERVING SKU. Never hard-code dollars here.
# refresh_model_services() always takes DBU rates from here, never from the table.
# ---------------------------------------------------------------------------
PLACEHOLDER = None
MODEL_PRICES = {
    "mc-claude-opus-5-5":       {"dbu_per_1m_input": PLACEHOLDER, "dbu_per_1m_output": PLACEHOLDER},
    "mc-gpt-6-1-sol":           {"dbu_per_1m_input": PLACEHOLDER, "dbu_per_1m_output": PLACEHOLDER},
    "mc-grok-4-7":              {"dbu_per_1m_input": PLACEHOLDER, "dbu_per_1m_output": PLACEHOLDER},
    "mc-claude-sonnet-5-5":     {"dbu_per_1m_input": PLACEHOLDER, "dbu_per_1m_output": PLACEHOLDER},
    "mc-gemini-3-8-flash":      {"dbu_per_1m_input": PLACEHOLDER, "dbu_per_1m_output": PLACEHOLDER},
    "mc-kimi-k3-1-pro":         {"dbu_per_1m_input": PLACEHOLDER, "dbu_per_1m_output": PLACEHOLDER},
    "mc-qwen35-122b":           {"dbu_per_1m_input": PLACEHOLDER, "dbu_per_1m_output": PLACEHOLDER},
    "mc-claude-haiku-5-5":      {"dbu_per_1m_input": PLACEHOLDER, "dbu_per_1m_output": PLACEHOLDER},
    "mc-gemini-3-1-flash-lite": {"dbu_per_1m_input": PLACEHOLDER, "dbu_per_1m_output": PLACEHOLDER},
    "mc-gpt-oss-20b":           {"dbu_per_1m_input": PLACEHOLDER, "dbu_per_1m_output": PLACEHOLDER},
}

# $/DBU lookup: provider tag -> SKU provider segment in system.billing.list_prices.
# This workspace bills on ENTERPRISE SKUs (checked in system.billing.usage); cloud is AWS.
SKU_TIER, SKU_CLOUD, SKU_CURRENCY = "ENTERPRISE", "AWS", "USD"
PROVIDER_SKU = {"anthropic": "ANTHROPIC", "openai": "OPENAI", "google": "GEMINI",
                "xai": "XAI", "moonshot_ai": "MOONSHOT", "alibaba": "ALIBABA"}

# Service definitions. Tags are written to the service as Unity Catalog tags;
# context_window is None where not confirmed (edit when known).
DEFAULT_TAGS = {
    "status": "experimental",
    "owner": "ai-governance",
    "hosting_type": "databricks_pay_per_token",
    "data_residency": "unverified",
    "pii_allowed": "false",
}
MODEL_SERVICES = [
    # name, system.ai model, capability_tier, cost_tier, licence_type, context_window
    ("mc-claude-opus-5-5",       "claude-opus-5-5",       "frontier",    "high",   "proprietary", None),
    ("mc-gpt-6-1-sol",           "gpt-6-1-sol",           "frontier",    "high",   "proprietary", None),
    ("mc-grok-4-7",              "grok-4-7",              "frontier",    "high",   "proprietary", None),
    ("mc-claude-sonnet-5-5",     "claude-sonnet-5-5",     "mid",         "medium", "proprietary", None),
    ("mc-gemini-3-8-flash",      "gemini-3-8-flash",      "mid",         "medium", "proprietary", None),
    ("mc-kimi-k3-1-pro",         "kimi-k3-1-pro",         "mid",         "medium", "open_weights", None),
    ("mc-qwen35-122b",           "qwen35-122b-a10b",      "mid",         "low",    "open_weights", None),
    ("mc-claude-haiku-5-5",      "claude-haiku-5-5",      "lightweight", "low",    "proprietary", None),
    ("mc-gemini-3-1-flash-lite", "gemini-3-1-flash-lite", "lightweight", "low",    "proprietary", None),
    ("mc-gpt-oss-20b",           "gpt-oss-20b",           "lightweight", "low",    "open_weights", None),
]
TAG_KEYS = ["capability_tier", "status", "provider", "hosting_type", "data_residency",
            "cost_tier", "owner", "licence_type", "pii_allowed"]

assert set(MODEL_PRICES) == {m[0] for m in MODEL_SERVICES}, "price dictionary and service list are out of sync"
print(f"run_mode={RUN_MODE}; {len(MODEL_SERVICES)} services configured in {PARENT}")

# COMMAND ----------

# DBTITLE 1,3. Helpers: backing model metadata and service API
import re
from databricks.sdk.errors import NotFound

MS_API = "/api/2.1/unity-catalog/model-services"


def get_service(fqn: str):
    try:
        return w.api_client.do("GET", f"{MS_API}/{fqn}")
    except NotFound:
        return None


def backing_model_info(system_model: str) -> dict:
    """Resolve the system.ai service's pay-per-token destination plus provider, version and licence from UC."""
    svc = w.api_client.do("GET", f"{MS_API}/system.ai.{system_model}")
    dest = svc["config"]["routing"]["destinations"][0]
    uc_model = dest["pay_per_token_config"]["model"].removeprefix("models/")
    meta = w.api_client.do("GET", f"/api/2.1/unity-catalog/models/{uc_model}")
    tags = {t["key"]: t.get("value") for t in meta.get("tags", [])}
    versions = w.api_client.do("GET", f"/api/2.1/unity-catalog/models/{uc_model}/versions").get("model_versions", [])
    latest = max(versions, key=lambda v: int(v["version"])) if versions else {}
    m = re.search(r"licensed under the \[[^\]]+\]\((https?://[^)]+)\)", latest.get("comment") or "")
    return {
        "underlying_model": uc_model,
        "version": str(latest.get("version")) if latest else None,
        "provider": tags.get("ai.model_creator", "unknown"),
        "licence_url": m.group(1) if m else None,
        "destination": {k: dest[k] for k in ("name", "destination_type", "pay_per_token_config")} | {"traffic_percentage": 100},
        "supported_api_types": svc.get("supported_api_types", []),
    }


print(backing_model_info("claude-haiku-5-5"))

# COMMAND ----------

# DBTITLE 1,4. Create or update services and tags (idempotent)
from databricks.sdk.errors import DatabricksError

TAG_API = "/api/2.1/unity-catalog/entity-tag-assignments"
TAG_ENTITY_TYPE = "model-services"


def read_tags(fqn: str) -> dict:
    out, token = {}, None
    while True:
        resp = w.api_client.do("GET", f"{TAG_API}/{TAG_ENTITY_TYPE}/{fqn}/tags", query={"page_token": token} if token else None)
        out |= {t["tag_key"]: t.get("tag_value") for t in resp.get("tag_assignments", [])}
        token = resp.get("next_page_token")
        if not token:
            return out


def set_tag(fqn: str, key: str, value: str, exists: bool):
    """Update the tag value if it already exists on the service, else create it."""
    if exists:
        w.api_client.do("PATCH", f"{TAG_API}/{TAG_ENTITY_TYPE}/{fqn}/tags/{key}", query={"update_mask": "tag_value"},
                        body={"tag_value": value})
    else:
        w.api_client.do("POST", TAG_API, body={"entity_type": TAG_ENTITY_TYPE, "entity_name": fqn,
                                               "tag_key": key, "tag_value": value})


def ensure_service(name, system_model, tier, cost_tier, licence_type, context_window) -> dict:
    fqn = f"{PARENT}.{name}"
    info = backing_model_info(system_model)
    comment = (f"Model catalog benchmark candidate: {system_model} ({info['provider']}, {tier} tier) "
               f"via Unity Gateway pay-per-token.")
    existing = get_service(fqn)
    if existing is None:
        body = {
            "comment": comment,
            "config": {
                "routing": {"destinations": [info["destination"]]},
                # Inference logging: payloads land in <prefix>_payload in this schema.
                "inference_table": {"parent": f"schemas/{PARENT}", "table_name_prefix": name.replace("-", "_")},
            },
        }
        w.api_client.do("POST", MS_API, query={"parent": f"schemas/{PARENT}", "model_service_id": name}, body=body)
        action = "created"
    else:
        cfg = existing.get("config", {})
        mask, patch = [], {"config": {}}
        cur_dest = [d.get("pay_per_token_config", {}).get("model") for d in cfg.get("routing", {}).get("destinations", [])]
        if cur_dest != [info["destination"]["pay_per_token_config"]["model"]]:
            patch["config"]["routing"] = {"destinations": [info["destination"]]}; mask.append("config.routing")
        if not cfg.get("inference_table"):
            patch["config"]["inference_table"] = {"parent": f"schemas/{PARENT}", "table_name_prefix": name.replace("-", "_")}
            mask.append("config.inference_table")
        if existing.get("comment") != comment:
            patch["comment"] = comment; mask.append("comment")
        if mask:
            w.api_client.do("PATCH", f"{MS_API}/{fqn}", query={"update_mask": ",".join(mask)}, body=patch)
        action = f"updated ({', '.join(mask)})" if mask else "unchanged"

    desired = DEFAULT_TAGS | {"capability_tier": tier, "cost_tier": cost_tier, "licence_type": licence_type,
                              "provider": info["provider"]}
    current = read_tags(fqn)
    # 'status' is owned by governance after creation: only set it when missing, never reset it.
    changed = [k for k in TAG_KEYS if current.get(k) != desired[k] and not (k == "status" and k in current)]
    written, blocked = [], []
    for k in changed:
        try:
            set_tag(fqn, k, desired[k], exists=k in current)
            written.append(k)
        except DatabricksError as e:
            if "tag policy" not in str(e):
                raise
            blocked.append(f"{k}={desired[k]}: {e}")  # governed tag policy rejects this value
    return {"service": name, "action": action, "tags_written": ", ".join(written),
            "tags_blocked_by_policy": " | ".join(blocked)}


if RUN_MODE == "setup":
    results = []
    for spec in MODEL_SERVICES:
        try:
            results.append(ensure_service(*spec))
        except DatabricksError as e:
            results.append({"service": spec[0], "action": f"ERROR: {e}"[:300], "tags_written": None})
    display(pd.DataFrame(results))
    if any(r.get("tags_blocked_by_policy") for r in results):
        print("WARNING: some tags were rejected by a governed tag policy (see tags_blocked_by_policy). "
              "An account admin must add the value to the policy, then re-run this cell.")
    assert not [r for r in results if str(r["action"]).startswith("ERROR")], "some services failed, see table above"

# COMMAND ----------

# DBTITLE 1,5. model_services table and refresh_model_services()
import hashlib, json
from pyspark.sql import types as T

CONTEXT_WINDOWS = {m[0]: m[5] for m in MODEL_SERVICES}

spark.sql(f"""
CREATE TABLE IF NOT EXISTS {MODEL_SERVICES_TABLE} (
  name STRING NOT NULL COMMENT 'Model service name (mc-<model>); merge key.',
  full_name STRING COMMENT 'Three-part Unity Catalog name used to invoke the service.',
  provider STRING COMMENT 'Model creator (provider tag, falls back to the backing model ai.model_creator tag).',
  underlying_model STRING COMMENT 'Backing Unity Catalog foundation model of the routing destination.',
  version STRING COMMENT 'Latest version of the backing foundation model.',
  capability_tier STRING COMMENT 'Tag: frontier, mid or lightweight.',
  status STRING COMMENT 'Tag: lifecycle status (experimental to start).',
  hosting_type STRING COMMENT 'Tag: how the model is hosted.',
  data_residency STRING COMMENT 'Tag: where inference data is processed.',
  cost_tier STRING COMMENT 'Tag: high, medium or low.',
  owner STRING COMMENT 'Tag: owning team (null if rejected by the governed owner tag policy).',
  licence_type STRING COMMENT 'Tag: proprietary or open_weights.',
  pii_allowed STRING COMMENT 'Tag: whether PII may be sent to this service.',
  tags MAP<STRING, STRING> COMMENT 'All tags currently on the service.',
  usd_per_1m_input_tokens DOUBLE COMMENT 'USD per 1M input tokens = dbu_per_1m_input_tokens x usd_per_dbu (null while on placeholder).',
  usd_per_1m_output_tokens DOUBLE COMMENT 'USD per 1M output tokens = dbu_per_1m_output_tokens x usd_per_dbu (null while on placeholder).',
  licence_url STRING COMMENT 'Licence / usage policy URL from the backing model version.',
  context_window INT COMMENT 'Context window in tokens (from the notebook config; null until confirmed).',
  description STRING COMMENT 'Service comment.',
  inference_table STRING COMMENT 'Inference (payload) logging table for the service.',
  supported_api_types ARRAY<STRING> COMMENT 'API types the service supports.',
  is_active BOOLEAN COMMENT 'False when the service no longer exists.',
  row_hash STRING COMMENT 'Hash of the descriptive columns, used to detect changes.',
  first_seen_at TIMESTAMP COMMENT 'When the service was first recorded.',
  updated_at TIMESTAMP COMMENT 'When any column last changed.',
  last_refreshed_at TIMESTAMP COMMENT 'When refresh_model_services() last saw the service.',
  dbu_per_1m_input_tokens DOUBLE COMMENT 'DBUs per 1M input tokens, always taken from MODEL_PRICES in 02_model_services.',
  dbu_per_1m_output_tokens DOUBLE COMMENT 'DBUs per 1M output tokens, always taken from MODEL_PRICES in 02_model_services.',
  price_sku STRING COMMENT 'system.billing.list_prices SKU used for the $/DBU rate (<TIER>_<PROVIDER>_MODEL_SERVING).',
  usd_per_dbu DOUBLE COMMENT 'Current list price in USD per DBU for price_sku (price_end_time IS NULL).',
  price_source STRING COMMENT 'list_price when DBU rates are set and a current list price was found; otherwise placeholder.'
) COMMENT 'Catalog of mc-* Unity Gateway model services for benchmarking: settings, tags and prices. Maintained by refresh_model_services() in 02_model_services.'
""")

# Add price columns to a table created before they existed (safe to re-run).
_existing_cols = {c.name for c in spark.table(MODEL_SERVICES_TABLE).schema}
for _col, _type, _cmt in [
    ("dbu_per_1m_input_tokens", "DOUBLE", "DBUs per 1M input tokens, always taken from MODEL_PRICES in 02_model_services."),
    ("dbu_per_1m_output_tokens", "DOUBLE", "DBUs per 1M output tokens, always taken from MODEL_PRICES in 02_model_services."),
    ("price_sku", "STRING", "system.billing.list_prices SKU used for the $/DBU rate (<TIER>_<PROVIDER>_MODEL_SERVING)."),
    ("usd_per_dbu", "DOUBLE", "Current list price in USD per DBU for price_sku (price_end_time IS NULL)."),
    ("price_source", "STRING", "list_price when DBU rates are set and a current list price was found; otherwise placeholder."),
]:
    if _col not in _existing_cols:
        spark.sql(f"ALTER TABLE {MODEL_SERVICES_TABLE} ADD COLUMNS ({_col} {_type} COMMENT '{_cmt}')")
for _io in ("input", "output"):  # USD is now derived, keep the comment accurate on older tables
    spark.sql(f"ALTER TABLE {MODEL_SERVICES_TABLE} ALTER COLUMN usd_per_1m_{_io}_tokens COMMENT "
              f"'USD per 1M {_io} tokens = dbu_per_1m_{_io}_tokens x usd_per_dbu (null while on placeholder).'")


def current_usd_per_dbu() -> dict:
    """Current $/DBU for every <TIER>_*_MODEL_SERVING SKU from system.billing.list_prices."""
    return {r.sku_name: float(r.usd_per_dbu) for r in spark.sql(f"""
        SELECT sku_name, pricing.effective_list.`default` AS usd_per_dbu
        FROM system.billing.list_prices
        WHERE price_end_time IS NULL AND usage_unit = 'DBU'
          AND cloud = '{SKU_CLOUD}' AND currency_code = '{SKU_CURRENCY}'
          AND sku_name LIKE '{SKU_TIER}\\_%\\_MODEL\\_SERVING'
    """).collect()}


STAGE_SCHEMA = T.StructType([T.StructField(c, t) for c, t in [
    ("name", T.StringType()), ("full_name", T.StringType()), ("provider", T.StringType()),
    ("underlying_model", T.StringType()), ("version", T.StringType()),
    *[(k, T.StringType()) for k in TAG_KEYS if k != "provider"],
    ("tags", T.MapType(T.StringType(), T.StringType())),
    ("usd_per_1m_input_tokens", T.DoubleType()), ("usd_per_1m_output_tokens", T.DoubleType()),
    ("dbu_per_1m_input_tokens", T.DoubleType()), ("dbu_per_1m_output_tokens", T.DoubleType()),
    ("price_sku", T.StringType()), ("usd_per_dbu", T.DoubleType()), ("price_source", T.StringType()),
    ("licence_url", T.StringType()), ("context_window", T.IntegerType()), ("description", T.StringType()),
    ("inference_table", T.StringType()), ("supported_api_types", T.ArrayType(T.StringType())),
    ("row_hash", T.StringType()),
]])


def uc_model_info(uc_model: str) -> dict:
    meta = w.api_client.do("GET", f"/api/2.1/unity-catalog/models/{uc_model}")
    versions = w.api_client.do("GET", f"/api/2.1/unity-catalog/models/{uc_model}/versions").get("model_versions", [])
    latest = max(versions, key=lambda v: int(v["version"])) if versions else {}
    m = re.search(r"licensed under the \[[^\]]+\]\((https?://[^)]+)\)", latest.get("comment") or "")
    return {"creator": {t["key"]: t.get("value") for t in meta.get("tags", [])}.get("ai.model_creator"),
            "version": str(latest["version"]) if latest else None, "licence_url": m.group(1) if m else None}


def refresh_model_services() -> dict:
    """List mc-* services, read current tags/settings, and MERGE into model_services.
    New services are inserted, changed rows updated, missing services set is_active=false.
    DBU rates always come from MODEL_PRICES; $/DBU from system.billing.list_prices."""
    usd_per_dbu = current_usd_per_dbu()
    rows, on_placeholder = [], []
    for s in list_model_services(PARENT):
        fqn = s["name"].removeprefix("model-services/")
        name = fqn.split(".")[-1]
        if not name.startswith(SERVICE_PREFIX):
            continue
        svc = w.api_client.do("GET", f"{MS_API}/{fqn}")  # list view omits routing details
        cfg = svc.get("config", {})
        dests = cfg.get("routing", {}).get("destinations", [])
        uc_model = dests[0]["pay_per_token_config"]["model"].removeprefix("models/") if dests and dests[0].get("pay_per_token_config") else None
        mi = uc_model_info(uc_model) if uc_model else {"creator": None, "version": None, "licence_url": None}
        tags = read_tags(fqn)
        price = MODEL_PRICES.get(name, {})
        provider = tags.get("provider") or mi["creator"]
        sku = f"{SKU_TIER}_{PROVIDER_SKU[provider]}_MODEL_SERVING" if provider in PROVIDER_SKU else None
        rate = usd_per_dbu.get(sku)
        dbu_in, dbu_out = price.get("dbu_per_1m_input"), price.get("dbu_per_1m_output")
        priced = dbu_in is not None and dbu_out is not None and rate is not None
        if not priced:
            reasons = (["DBU rates are placeholders"] if dbu_in is None or dbu_out is None else []) + \
                      ([f"no current list price for {sku or 'provider ' + str(provider)}"] if rate is None else [])
            on_placeholder.append(f"{name} ({'; '.join(reasons)})")
        row = {
            "name": name, "full_name": fqn, "provider": tags.get("provider") or mi["creator"],
            "underlying_model": uc_model, "version": mi["version"],
            **{k: tags.get(k) for k in TAG_KEYS if k != "provider"},
            "tags": tags,
            "usd_per_1m_input_tokens": dbu_in * rate if priced else None,
            "usd_per_1m_output_tokens": dbu_out * rate if priced else None,
            "dbu_per_1m_input_tokens": dbu_in, "dbu_per_1m_output_tokens": dbu_out,
            "price_sku": sku, "usd_per_dbu": rate, "price_source": "list_price" if priced else "placeholder",
            "licence_url": mi["licence_url"], "context_window": CONTEXT_WINDOWS.get(name),
            "description": svc.get("comment"),
            "inference_table": (cfg.get("inference_table") or {}).get("table", "").removeprefix("tables/") or None,
            "supported_api_types": svc.get("supported_api_types", []),
        }
        row["row_hash"] = hashlib.sha256(json.dumps(row, sort_keys=True, default=str).encode()).hexdigest()
        rows.append(row)

    spark.createDataFrame(rows, STAGE_SCHEMA).createOrReplaceTempView("model_services_stage")
    cols = [f.name for f in STAGE_SCHEMA.fields]
    m = spark.sql(f"""
    MERGE INTO {MODEL_SERVICES_TABLE} t
    USING model_services_stage s ON t.name = s.name
    WHEN MATCHED AND (t.row_hash <> s.row_hash OR NOT t.is_active) THEN UPDATE SET
      {', '.join(f't.{c} = s.{c}' for c in cols)}, t.is_active = true,
      t.updated_at = current_timestamp(), t.last_refreshed_at = current_timestamp()
    WHEN MATCHED THEN UPDATE SET t.last_refreshed_at = current_timestamp()
    WHEN NOT MATCHED THEN INSERT ({', '.join(cols)}, is_active, first_seen_at, updated_at, last_refreshed_at)
      VALUES ({', '.join(f's.{c}' for c in cols)}, true, current_timestamp(), current_timestamp(), current_timestamp())
    WHEN NOT MATCHED BY SOURCE AND t.is_active THEN UPDATE SET
      t.is_active = false, t.updated_at = current_timestamp()
    """).first().asDict()
    print(f"refresh_model_services: {len(rows)} mc-* services seen; merge result {m}")
    if on_placeholder:
        print(f"WARNING: {len(on_placeholder)} model(s) still on placeholder prices (USD is null):\n  - "
              + "\n  - ".join(on_placeholder))
    return m

# COMMAND ----------

# DBTITLE 1,6. Run refresh and show the catalog
refresh_result = refresh_model_services()
display(spark.sql(f"""
SELECT name, provider, underlying_model, version, capability_tier, status, cost_tier, owner, licence_type,
       pii_allowed, data_residency, hosting_type, price_source, price_sku, usd_per_dbu,
       dbu_per_1m_input_tokens, dbu_per_1m_output_tokens, usd_per_1m_input_tokens, usd_per_1m_output_tokens,
       licence_url, inference_table, is_active, updated_at
FROM {MODEL_SERVICES_TABLE} ORDER BY capability_tier, name"""))