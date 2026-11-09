# Databricks notebook source
# DBTITLE 1,Overview
# MAGIC %md
# MAGIC # 03_run_benchmark
# MAGIC
# MAGIC Benchmarks `mc-*` model services on one use case. The system prompt, metric list, headline metrics, thresholds, gold table and daily volume come only from `model_catalog.use_case_config`; prices come from `model_catalog.model_services`.
# MAGIC
# MAGIC Parameters: `model_services` (comma-separated or `all`), `use_case_id`, `sample_size` (`all` or N, a fixed hash-ordered sample so every model sees the same records), `judge_model`.
# MAGIC
# MAGIC Flow: call every service on every record in parallel (per-service concurrency cap, retries with back-off on 429/5xx, honours `Retry-After`) -> score with `mlflow.genai.evaluate` (code scorers + one LLM-judge scorer that returns faithfulness / completeness / conciseness / reference_accuracy) -> compute classification and operational metrics -> append to `benchmark_results` and `benchmark_examples`. MLflow experiment: `model-catalog/<use_case_id>`, one parent run per benchmark run and one child run per model.
# MAGIC
# MAGIC Scoring rules: an unparseable or failed response counts as a negative prediction with no triggers, and fails every judge criterion. `json_validity` is strict: the raw response must be a bare JSON object matching the output schema (code fences fail).

# COMMAND ----------

# DBTITLE 1,1. Parameters and configuration from use_case_config
import json, os, random, re, threading, time, uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import mlflow
import numpy as np
import pandas as pd
import requests
from databricks.sdk import WorkspaceClient
from pyspark.sql import functions as F, types as T

dbutils.widgets.text("model_services", "all", "Model services (comma-separated or all)")
dbutils.widgets.dropdown("use_case_id", "fraud_detection",
                         ["fraud_detection", "call_summarization", "churn_detection"], "Use case")
dbutils.widgets.text("sample_size", "all", "Sample size (all or N)")
dbutils.widgets.text("judge_model", "system.ai.claude-sonnet-4-6", "Judge model service")

CATALOG, SCHEMA = "serverless_nv91sa_catalog", "model_catalog"
PARENT = f"{CATALOG}.{SCHEMA}"
RESULTS_TABLE = f"{PARENT}.benchmark_results"
EXAMPLES_TABLE = f"{PARENT}.benchmark_examples"
LATEST_VIEW = f"{PARENT}.v_latest_results"
EXPERIMENT_ROOT = "/Workspace/Users/subhannita.sarcar@databricks.com/model-catalog"

MAX_TOKENS = 2048          # model output budget (reasoning models need headroom)
MAX_ATTEMPTS = 6           # per request, for 408/429/5xx and network errors
MODEL_CONCURRENCY = 8      # parallel requests per model service
TOTAL_CONCURRENCY = 32     # parallel requests overall during generation
JUDGE_CONCURRENCY = 12     # parallel judge calls (MLflow evaluate workers)
REQUEST_TIMEOUT_S = 180

USE_CASE_ID = dbutils.widgets.get("use_case_id").strip()
_ss = dbutils.widgets.get("sample_size").strip().lower()
SAMPLE_SIZE = None if _ss in ("", "all") else int(_ss)
JUDGE_MODEL = dbutils.widgets.get("judge_model").strip()
REQUESTED = [s.strip() for s in dbutils.widgets.get("model_services").split(",") if s.strip()]

# --- Everything use-case specific comes from use_case_config ---
_cfg = spark.sql(f"SELECT * FROM {PARENT}.use_case_config WHERE use_case_id = :u", args={"u": USE_CASE_ID}).collect()
assert len(_cfg) == 1, f"use_case_id {USE_CASE_ID!r} not found in use_case_config"
CFG = _cfg[0].asDict(recursive=True)
SYSTEM_PROMPT = CFG["system_prompt"]
METRICS = list(CFG["metrics"])
HEADLINE = list(CFG["headline_metrics"])
THRESHOLDS = {k: (v["direction"], float(v["value"])) for k, v in (CFG["thresholds"] or {}).items()}
GOLD_TABLE = CFG["gold_table"]
DAILY_VOLUME = CFG["daily_volume"]

# --- Services and prices from model_services ---
_svc = spark.table(f"{PARENT}.model_services").where("is_active").toPandas()
if [s.lower() for s in REQUESTED] == ["all"]:
    _sel = _svc
else:
    _names = [s.split(".")[-1] for s in REQUESTED]
    _missing = sorted(set(_names) - set(_svc["name"]))
    assert not _missing, f"unknown or inactive model services: {_missing}"
    _sel = _svc[_svc["name"].isin(_names)]
SERVICES = _sel.sort_values("name")[["name", "full_name", "usd_per_1m_input_tokens", "usd_per_1m_output_tokens",
                                      "price_source"]].to_dict("records")
assert SERVICES, "no model services selected"

# --- Gold data (fixed hash-ordered sample so all models see the same records) ---
_gold = spark.table(GOLD_TABLE)
_versions = [r[0] for r in _gold.select("dataset_version").distinct().collect()]
assert len(_versions) == 1, f"expected one dataset_version in {GOLD_TABLE}, found {_versions}"
DATASET_VERSION = _versions[0]
if USE_CASE_ID == "fraud_detection":
    FRAUD_TRIGGER_IDS = sorted({t for r in _gold.select(F.explode("expected_triggers")).distinct().collect() for t in r})
_sample = _gold.orderBy(F.xxhash64("record_id")).limit(SAMPLE_SIZE) if SAMPLE_SIZE else _gold
RECORDS = [r.asDict(recursive=True) for r in _sample.orderBy("record_id").collect()]

RUN_TS = datetime.now(timezone.utc)
RUN_ID = f"{RUN_TS:%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}"
print(f"run_id={RUN_ID} use_case={USE_CASE_ID} dataset={DATASET_VERSION} records={len(RECORDS)} "
      f"services={[s['name'] for s in SERVICES]} judge={JUDGE_MODEL}")
print(f"metrics from config: {METRICS}\nheadline: {HEADLINE}\nthresholds: {THRESHOLDS}")
unpriced = [s["name"] for s in SERVICES if s["price_source"] != "list_price"]
if unpriced:
    print(f"WARNING: no list price yet for {unpriced}; cost_per_1k / projected_monthly_cost will be null for them.")

# COMMAND ----------

# DBTITLE 1,2. Use case adapters: inputs, expectations, output parsing
def user_message(rec: dict) -> str:
    if USE_CASE_ID == "churn_detection":
        return (f"Customer tenure (years): {rec['tenure_years']}\nProducts held: {rec['product_count']}\n"
                f"Channel: {rec['channel']}\n\nInteraction:\n{rec['interaction_text']}")
    return rec["transcript"]


def expectations_for(rec: dict) -> dict:
    if USE_CASE_ID == "fraud_detection":
        return {"expected_triggers": list(rec["expected_triggers"]), "is_fraud": bool(rec["is_fraud"])}
    if USE_CASE_ID == "call_summarization":
        return {"reference_summary": rec["reference_summary"], "key_facts": list(rec["key_facts"])}
    return {"churn_label": bool(rec["churn_label"])}


_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.I)


def parse_output(text):
    """Return (parsed_or_None, strict) where strict means the raw text was a bare JSON object."""
    if not text or not text.strip():
        return None, False
    try:
        obj = json.loads(text.strip())
        return (obj, True) if isinstance(obj, dict) else (None, False)
    except json.JSONDecodeError:
        pass
    cleaned = _FENCE.sub("", text.strip())
    m = re.search(r"\{.*\}", cleaned, re.S)
    if m:
        try:
            obj = json.loads(m.group(0))
            return (obj, False) if isinstance(obj, dict) else (None, False)
        except json.JSONDecodeError:
            return None, False
    return None, False


def schema_ok(p) -> bool:
    """Does the parsed object match the JSON output format required by the system prompt?"""
    if not isinstance(p, dict):
        return False
    if USE_CASE_ID == "fraud_detection":
        return (isinstance(p.get("triggers"), list) and isinstance(p.get("is_fraud_risk"), bool)
                and isinstance(p.get("rationale"), str)
                and all(isinstance(t, dict) and t.get("trigger") in FRAUD_TRIGGER_IDS and isinstance(t.get("evidence"), str)
                        for t in p["triggers"]))
    if USE_CASE_ID == "call_summarization":
        return (isinstance(p.get("summary"), str) and isinstance(p.get("key_facts"), list)
                and all(isinstance(f, str) for f in p["key_facts"]))
    conf = p.get("confidence")
    return (isinstance(p.get("churn_risk"), bool) and isinstance(conf, (int, float)) and 0 <= conf <= 1
            and isinstance(p.get("signals"), list) and isinstance(p.get("rationale"), str))


def predicted_fraud(p):
    """(is_fraud_pred, trigger_set). Unparseable -> (False, empty set)."""
    if not isinstance(p, dict):
        return False, set()
    trig = {t.get("trigger") for t in p.get("triggers") or [] if isinstance(t, dict)} & set(FRAUD_TRIGGER_IDS)
    flag = p.get("is_fraud_risk")
    return (flag if isinstance(flag, bool) else bool(trig)), trig


def predicted_churn(p) -> bool:
    return isinstance(p, dict) and p.get("churn_risk") is True


def sentence_count(s) -> int:
    return len([x for x in re.split(r"(?<=[.!?])\s+", (s or "").strip()) if x])

# COMMAND ----------

# DBTITLE 1,3. Unity Gateway client with parallelism, retries and rate-limit handling
w = WorkspaceClient()
GATEWAY_URL = f"{w.config.host.rstrip('/')}/ai-gateway/mlflow/v1/chat/completions"
RETRYABLE = {408, 429, 500, 502, 503, 504}
_tls = threading.local()
_sem_lock = threading.Lock()
_semaphores: dict[str, threading.BoundedSemaphore] = {}
_no_temperature: set[str] = set()   # services that reject the temperature parameter


def _session() -> requests.Session:
    if not hasattr(_tls, "s"):
        _tls.s = requests.Session()
    return _tls.s


def _semaphore(service: str, limit: int) -> threading.BoundedSemaphore:
    with _sem_lock:
        return _semaphores.setdefault(service, threading.BoundedSemaphore(limit))


def _text(message: dict) -> str:
    c = message.get("content")
    if isinstance(c, list):  # some providers return content parts
        c = "".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type", "text") == "text")
    return c or ""


def chat(service: str, system: str, user: str, max_tokens: int = MAX_TOKENS, concurrency: int = MODEL_CONCURRENCY) -> dict:
    """Call a model service via the Unity Gateway MLflow chat API. Never raises; returns error info instead."""
    out = {"text": None, "input_tokens": None, "output_tokens": None, "latency_ms": None, "attempts": 0,
           "error": None, "status": None}
    with _semaphore(service, concurrency):
        attempt = 0
        while True:
            attempt += 1
            out["attempts"] = attempt
            body = {"model": service, "max_tokens": max_tokens,
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
            if service not in _no_temperature:
                body["temperature"] = 0
            t0 = time.perf_counter()
            try:
                r = _session().post(GATEWAY_URL, json=body, timeout=REQUEST_TIMEOUT_S,
                                    headers={**w.config.authenticate(), "Content-Type": "application/json"})
            except requests.RequestException as e:
                if attempt < MAX_ATTEMPTS:
                    time.sleep(min(60, 2 ** attempt) + random.random())
                    continue
                out["error"] = f"network: {e}"[:500]
                return out
            elapsed = (time.perf_counter() - t0) * 1000
            out["status"] = r.status_code
            if r.status_code == 200:
                data = r.json()
                usage = data.get("usage") or {}
                out.update(text=_text(data["choices"][0]["message"]), latency_ms=elapsed,
                           input_tokens=usage.get("prompt_tokens"), output_tokens=usage.get("completion_tokens"))
                return out
            if r.status_code == 400 and "temperature" in r.text.lower() and service not in _no_temperature:
                _no_temperature.add(service)  # retry immediately without temperature; not counted as an attempt
                attempt -= 1
                continue
            if r.status_code in RETRYABLE and attempt < MAX_ATTEMPTS:
                try:
                    wait = float(r.headers.get("Retry-After", ""))
                except ValueError:
                    wait = min(60, 2 ** attempt) + random.random()
                time.sleep(wait)
                continue
            out["error"] = f"HTTP {r.status_code}: {r.text}"[:500]
            return out


_probe = chat(SERVICES[0]["full_name"], "Reply with the JSON object {\"ok\": true} only.", "ping", max_tokens=50)
print({k: _probe[k] for k in ("status", "error", "latency_ms", "text")})

# COMMAND ----------

# DBTITLE 1,4. Scorers: code scorers and LLM judge
from mlflow.entities import AssessmentSource, Feedback
from mlflow.genai.scorers import scorer

# Judge criteria that apply to this use case = intersection with the config metric list.
JUDGE_RUBRIC = {
    "faithfulness": "Every claim in the output (quoted evidence, rationale, summary sentences, key facts, signals) is "
                    "explicitly supported by the source text. Any invented, altered or unsupported claim means 'no'.",
    "completeness": {
        "fraud_detection": "The output identifies every expected trigger listed under EXPECTED with supporting evidence. "
                           "If EXPECTED lists no triggers, 'yes' only when the output flags no triggers.",
        "call_summarization": "The summary and key facts together cover every key fact listed under EXPECTED.",
    }.get(USE_CASE_ID),
    "conciseness": "The output contains only what the requested JSON format asks for, without padding, repetition or "
                   "irrelevant detail (e.g. rationale is one sentence; summary is three sentences).",
    "reference_accuracy": "The summary conveys the same information as the REFERENCE summary with no contradictions "
                          "or material omissions; wording may differ." if USE_CASE_ID == "call_summarization" else None,
}
JUDGE_CRITERIA = [c for c in ["faithfulness", "completeness", "conciseness", "reference_accuracy"]
                  if c in METRICS and JUDGE_RUBRIC.get(c)]
JUDGE_SYSTEM = ("You are a strict evaluator of an insurance AI assistant's outputs. Judge each criterion independently "
                "using only the material provided. Return ONLY a JSON object: "
                '{"<criterion>": {"verdict": "yes" | "no", "rationale": "<one or two sentences>"}, ...} '
                "with exactly these criteria as keys: " + ", ".join(JUDGE_CRITERIA) + ".")
_JUDGE_SOURCE = AssessmentSource(source_type="LLM_JUDGE", source_id=JUDGE_MODEL)


def _judge_prompt(inputs, outputs, expectations) -> str:
    parts = [f"TASK: {CFG['display_name']}", "CRITERIA:"]
    parts += [f"- {c}: {JUDGE_RUBRIC[c]}" for c in JUDGE_CRITERIA]
    parts += ["", "SOURCE TEXT:", inputs["input"], ""]
    if USE_CASE_ID == "fraud_detection":
        parts += [f"EXPECTED triggers: {expectations['expected_triggers']}"]
    elif USE_CASE_ID == "call_summarization":
        parts += [f"EXPECTED key facts: {json.dumps(expectations['key_facts'])}",
                  f"REFERENCE summary: {expectations['reference_summary']}"]
    parts += ["", "MODEL OUTPUT:", outputs["response"]]
    return "\n".join(parts)


@scorer
def json_validity(outputs) -> Feedback:
    ok = bool(outputs.get("json_valid"))
    return Feedback(value=ok, rationale="Bare JSON object matching the required schema." if ok
                    else "Not a bare JSON object matching the required output schema.")


@scorer
def label_match(outputs, expectations) -> list[Feedback]:
    """Row-level correctness against gold labels (aggregates are computed from the same rule set)."""
    p = outputs.get("parsed")
    if USE_CASE_ID == "fraud_detection":
        flag, trig = predicted_fraud(p)
        exp = set(expectations["expected_triggers"])
        return [Feedback(name="fraud_correct", value=flag == expectations["is_fraud"],
                         rationale=f"predicted is_fraud={flag}, expected {expectations['is_fraud']}"),
                Feedback(name="triggers_exact", value=trig == exp,
                         rationale=f"predicted {sorted(trig)}, expected {sorted(exp)}"),
                Feedback(name="trigger_tp", value=len(trig & exp)),
                Feedback(name="trigger_fp", value=len(trig - exp)),
                Feedback(name="trigger_fn", value=len(exp - trig))]
    if USE_CASE_ID == "churn_detection":
        pred = predicted_churn(p)
        return [Feedback(name="churn_correct", value=pred == expectations["churn_label"],
                         rationale=f"predicted churn={pred}, expected {expectations['churn_label']}")]
    n = sentence_count(p.get("summary") if isinstance(p, dict) else None)
    return [Feedback(name="three_sentences", value=n == 3, rationale=f"summary has {n} sentence(s)")]


@scorer
def llm_judge(inputs, outputs, expectations) -> list[Feedback]:
    if not outputs.get("response"):
        return [Feedback(name=c, value=False, source=_JUDGE_SOURCE,
                         rationale="No model output (call failed or empty response).") for c in JUDGE_CRITERIA]
    res = chat(JUDGE_MODEL, JUDGE_SYSTEM, _judge_prompt(inputs, outputs, expectations), max_tokens=1500,
               concurrency=JUDGE_CONCURRENCY)
    parsed, _ = parse_output(res["text"])
    if res["error"] or not isinstance(parsed, dict):
        err = res["error"] or f"unparseable judge output: {(res['text'] or '')[:200]}"
        return [Feedback(name=c, error=err, source=_JUDGE_SOURCE) for c in JUDGE_CRITERIA]
    fbs = []
    for c in JUDGE_CRITERIA:
        v = parsed.get(c) if isinstance(parsed.get(c), dict) else {}
        verdict = str(v.get("verdict", "")).strip().lower()
        if verdict in ("yes", "no"):
            fbs.append(Feedback(name=c, value=verdict == "yes", rationale=str(v.get("rationale", "")), source=_JUDGE_SOURCE))
        else:
            fbs.append(Feedback(name=c, error=f"judge gave no yes/no verdict for {c}", source=_JUDGE_SOURCE))
    return fbs


SCORERS = [json_validity, label_match] + ([llm_judge] if JUDGE_CRITERIA else [])
print("judge criteria:", JUDGE_CRITERIA)

# COMMAND ----------

# DBTITLE 1,5. Result tables and latest-results view
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {RESULTS_TABLE} (
  run_id STRING COMMENT 'Benchmark run id (one per 03_run_benchmark execution).',
  run_ts TIMESTAMP COMMENT 'Benchmark run start time (UTC).',
  model_service STRING COMMENT 'Model service name (mc-<model>).',
  use_case_id STRING COMMENT 'Use case from use_case_config.',
  dataset_version STRING COMMENT 'Gold dataset version scored.',
  metric_name STRING COMMENT 'Metric name from use_case_config.metrics (per-trigger metrics are <metric>.<trigger_id>).',
  metric_value DOUBLE COMMENT 'Metric value (null when not computable, e.g. cost without a list price).',
  is_headline BOOLEAN COMMENT 'True when the metric is in use_case_config.headline_metrics.',
  passes_threshold BOOLEAN COMMENT 'Threshold check from use_case_config.thresholds; null when no threshold or no value.',
  threshold_direction STRING COMMENT 'gte or lte, from use_case_config.thresholds.',
  threshold_value DOUBLE COMMENT 'Threshold value from use_case_config.thresholds.',
  sample_size INT COMMENT 'Number of gold records scored.',
  judge_model STRING COMMENT 'Model service used for LLM-judge scorers.',
  price_source STRING COMMENT 'model_services.price_source at run time (placeholder or list_price).',
  mlflow_run_id STRING COMMENT 'MLflow child run with the evaluation for this model.'
) COMMENT 'Benchmark metrics: one row per run x model service x metric. Written by 03_run_benchmark (append only).'
""")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {EXAMPLES_TABLE} (
  run_id STRING COMMENT 'Benchmark run id.',
  run_ts TIMESTAMP COMMENT 'Benchmark run start time (UTC).',
  model_service STRING COMMENT 'Model service name.',
  use_case_id STRING COMMENT 'Use case.',
  dataset_version STRING COMMENT 'Gold dataset version.',
  record_id STRING COMMENT 'Gold record id.',
  model_input STRING COMMENT 'User message sent to the model (the system prompt comes from use_case_config).',
  model_output STRING COMMENT 'Raw model response text (null when the call failed).',
  parsed_output STRING COMMENT 'Parsed JSON output (lenient parse), as JSON text.',
  expected STRING COMMENT 'Gold expectations for the record, as JSON text.',
  judge_rationale MAP<STRING, STRING> COMMENT 'LLM-judge rationale per criterion.',
  scores MAP<STRING, DOUBLE> COMMENT 'Per-record scorer values (booleans as 1/0).',
  json_valid BOOLEAN COMMENT 'Strict JSON output-format validity.',
  error STRING COMMENT 'Model call error after retries, if any.',
  latency_ms DOUBLE COMMENT 'Latency of the successful attempt in ms.',
  input_tokens INT COMMENT 'Prompt tokens reported by the gateway.',
  output_tokens INT COMMENT 'Completion tokens reported by the gateway.',
  attempts INT COMMENT 'Request attempts including retries.',
  mlflow_run_id STRING COMMENT 'MLflow child run id.',
  mlflow_trace_id STRING COMMENT 'MLflow evaluation trace id for this record.'
) COMMENT 'Benchmark examples: one row per run x model service x gold record. Written by 03_run_benchmark (append only).'
""")
spark.sql(f"""
CREATE OR REPLACE VIEW {LATEST_VIEW}
COMMENT 'benchmark_results restricted to the latest run per model_service x use_case_id.'
AS SELECT * FROM {RESULTS_TABLE}
QUALIFY DENSE_RANK() OVER (PARTITION BY model_service, use_case_id ORDER BY run_ts DESC, run_id DESC) = 1
""")

RESULTS_SCHEMA = spark.table(RESULTS_TABLE).schema
EXAMPLES_SCHEMA = spark.table(EXAMPLES_TABLE).schema
print("tables ready")

# COMMAND ----------

# DBTITLE 1,6. Generate model outputs in parallel
def run_generation(services, records) -> dict:
    tasks = [(s, r) for s in services for r in records]
    out, t0 = {}, time.time()
    with ThreadPoolExecutor(max_workers=TOTAL_CONCURRENCY) as ex:
        futs = {ex.submit(chat, s["full_name"], SYSTEM_PROMPT, user_message(r)): (s["name"], r["record_id"])
                for s, r in tasks}
        for i, f in enumerate(as_completed(futs), 1):
            out[futs[f]] = f.result()
            if i % 100 == 0 or i == len(tasks):
                print(f"  generated {i}/{len(tasks)} in {time.time() - t0:.0f}s")
    return out


GENERATIONS = run_generation(SERVICES, RECORDS)
_err = pd.DataFrame([{"service": k[0], "error": v["error"] is not None} for k, v in GENERATIONS.items()])
display(_err.groupby("service")["error"].agg(["count", "sum"]).rename(columns={"sum": "errors"}).reset_index())

# COMMAND ----------

# DBTITLE 1,7. Evaluate with MLflow, compute metrics, write results
os.environ["MLFLOW_GENAI_EVAL_MAX_WORKERS"] = str(JUDGE_CONCURRENCY)
EXPERIMENT = f"{EXPERIMENT_ROOT}/{USE_CASE_ID}"
mlflow.set_experiment(EXPERIMENT)


def _prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return p, r, (2 * p * r / (p + r) if p + r else 0.0)


def _binary(pred, gold):
    tp = sum(p and g for p, g in zip(pred, gold)); fp = sum(p and not g for p, g in zip(pred, gold))
    fn = sum(g and not p for p, g in zip(pred, gold))
    p, r, f1 = _prf(tp, fp, fn)
    return {"accuracy": float(np.mean([p_ == g for p_, g in zip(pred, gold)])), "precision": p, "recall": r, "f1": f1}


def compute_metrics(svc, gens, scores_by_rid) -> dict:
    m = {}
    parsed = [gens[r["record_id"]]["parsed"] for r in RECORDS]
    m["json_validity"] = float(np.mean([gens[r["record_id"]]["json_valid"] for r in RECORDS]))
    if USE_CASE_ID == "fraud_detection":
        preds = [predicted_fraud(p) for p in parsed]
        b = _binary([p[0] for p in preds], [r["is_fraud"] for r in RECORDS])
        m.update({f"fraud_{k}": v for k, v in b.items()})
        exp = [set(r["expected_triggers"]) for r in RECORDS]
        tp = sum(len(p[1] & e) for p, e in zip(preds, exp)); fp = sum(len(p[1] - e) for p, e in zip(preds, exp))
        fn = sum(len(e - p[1]) for p, e in zip(preds, exp))
        m["trigger_precision"], m["trigger_recall"], m["trigger_f1"] = _prf(tp, fp, fn)
        for t in FRAUD_TRIGGER_IDS:
            ttp = sum(t in p[1] and t in e for p, e in zip(preds, exp)); tfp = sum(t in p[1] and t not in e for p, e in zip(preds, exp))
            tfn = sum(t in e and t not in p[1] for p, e in zip(preds, exp))
            (m[f"trigger_precision.{t}"], m[f"trigger_recall.{t}"], m[f"trigger_f1.{t}"]) = _prf(ttp, tfp, tfn)
    elif USE_CASE_ID == "churn_detection":
        m.update(_binary([predicted_churn(p) for p in parsed], [r["churn_label"] for r in RECORDS]))
    else:
        m["sentence_count_compliance"] = float(np.mean(
            [sentence_count(p.get("summary")) == 3 if isinstance(p, dict) else False for p in parsed]))
    for c in JUDGE_CRITERIA:
        vals = [scores_by_rid.get(r["record_id"], {}).get(c) for r in RECORDS]
        vals = [v for v in vals if v is not None]
        m[c] = float(np.mean(vals)) if vals else None
    ok = [g for g in (gens[r["record_id"]] for r in RECORDS) if g["error"] is None]
    lat = [g["latency_ms"] for g in ok]
    m["latency_p50_ms"] = float(np.percentile(lat, 50)) if lat else None
    m["latency_p95_ms"] = float(np.percentile(lat, 95)) if lat else None
    m["error_rate"] = 1 - len(ok) / len(RECORDS)
    tin = [g["input_tokens"] for g in ok if g["input_tokens"] is not None]
    tout = [g["output_tokens"] for g in ok if g["output_tokens"] is not None]
    m["avg_input_tokens"] = float(np.mean(tin)) if tin else None
    m["avg_output_tokens"] = float(np.mean(tout)) if tout else None
    pin, pout = svc["usd_per_1m_input_tokens"], svc["usd_per_1m_output_tokens"]
    priced = all(x is not None and not pd.isna(x) for x in (pin, pout, m["avg_input_tokens"], m["avg_output_tokens"]))
    m["cost_per_1k"] = 1000 * (m["avg_input_tokens"] * pin + m["avg_output_tokens"] * pout) / 1e6 if priced else None
    m["projected_monthly_cost"] = m["cost_per_1k"] * DAILY_VOLUME / 1000 * 30 if priced else None
    return m


def config_metric_names(computed: dict) -> list[str]:
    """Metrics to write = use_case_config.metrics, with per_trigger_metrics expanded."""
    names = []
    for name in METRICS:
        if name == "per_trigger_metrics":
            names += sorted(k for k in computed if "." in k)
        elif name in computed:
            names.append(name)
        else:
            print(f"WARNING: metric {name!r} in use_case_config is not computed by this notebook; skipped")
    return names


def _passes(name, value):
    if name not in THRESHOLDS or value is None:
        return None
    d, t = THRESHOLDS[name]
    return value >= t if d == "gte" else value <= t


def _assessments(row):
    """(scores, rationales) for one eval_results row."""
    scores, rats = {}, {}
    for a in row.get("assessments") or []:
        a = a.to_dictionary() if hasattr(a, "to_dictionary") else a
        fb = a.get("feedback")
        if fb is None:
            continue
        name, val = a.get("assessment_name"), fb.get("value")
        scores[name] = float(val) if isinstance(val, (bool, int, float)) else None
        if name in JUDGE_CRITERIA:
            rats[name] = a.get("rationale") or (fb.get("error") or {}).get("error_message")
    return scores, rats


summary, failed = [], []
with mlflow.start_run(run_name=f"{USE_CASE_ID}-{RUN_ID}") as parent:
    mlflow.set_tags({"benchmark_run_id": RUN_ID, "use_case_id": USE_CASE_ID, "dataset_version": DATASET_VERSION})
    mlflow.log_params({"judge_model": JUDGE_MODEL, "sample_size": len(RECORDS), "model_services": ",".join(s["name"] for s in SERVICES)})
    for svc in SERVICES:
        name = svc["name"]
        gens = {}
        for r in RECORDS:
            g = dict(GENERATIONS[(name, r["record_id"])])
            g["parsed"], strict = parse_output(g["text"])
            g["json_valid"] = strict and schema_ok(g["parsed"])
            gens[r["record_id"]] = g
        data = [{"inputs": {"record_id": r["record_id"], "input": user_message(r)},
                 "outputs": {"response": gens[r["record_id"]]["text"] or "", "parsed": gens[r["record_id"]]["parsed"],
                             "json_valid": gens[r["record_id"]]["json_valid"], "error": gens[r["record_id"]]["error"]},
                 "expectations": expectations_for(r)} for r in RECORDS]
        try:
            with mlflow.start_run(run_name=name, nested=True) as child:
                mlflow.set_tags({"benchmark_run_id": RUN_ID, "model_service": name, "use_case_id": USE_CASE_ID,
                                 "dataset_version": DATASET_VERSION, "judge_model": JUDGE_MODEL})
                res = mlflow.genai.evaluate(data=data, scorers=SCORERS)
                rows = res.tables["eval_results"].to_dict("records")
                per_rid = {}
                for row in rows:
                    sc, rat = _assessments(row)
                    per_rid[row["request"]["record_id"]] = (sc, rat, row.get("trace_id"))
                computed = compute_metrics(svc, gens, {k: v[0] for k, v in per_rid.items()})
                names = config_metric_names(computed)
                mlflow.log_metrics({k: computed[k] for k in names if computed[k] is not None})
                run_uuid = child.info.run_id

            res_rows = [(RUN_ID, RUN_TS, name, USE_CASE_ID, DATASET_VERSION, k,
                         None if computed[k] is None else float(computed[k]), k in HEADLINE, _passes(k, computed[k]),
                         THRESHOLDS.get(k, (None, None))[0], THRESHOLDS.get(k, (None, None))[1],
                         len(RECORDS), JUDGE_MODEL, svc["price_source"], run_uuid) for k in names]
            spark.createDataFrame(res_rows, RESULTS_SCHEMA).write.mode("append").saveAsTable(RESULTS_TABLE)

            ex_rows = []
            for r in RECORDS:
                g = gens[r["record_id"]]
                sc, rat, trace_id = per_rid.get(r["record_id"], ({}, {}, None))
                ex_rows.append((RUN_ID, RUN_TS, name, USE_CASE_ID, DATASET_VERSION, r["record_id"], user_message(r),
                                g["text"], json.dumps(g["parsed"]) if g["parsed"] is not None else None,
                                json.dumps(expectations_for(r)), {k: v for k, v in rat.items() if v},
                                {k: v for k, v in sc.items() if v is not None}, bool(g["json_valid"]), g["error"],
                                g["latency_ms"], g["input_tokens"], g["output_tokens"], g["attempts"], run_uuid, trace_id))
            spark.createDataFrame(ex_rows, EXAMPLES_SCHEMA).write.mode("append").saveAsTable(EXAMPLES_TABLE)
            summary.append({"model_service": name, **{k: computed[k] for k in HEADLINE}, "error_rate": computed["error_rate"]})
            print(f"{name}: wrote {len(res_rows)} metrics, {len(ex_rows)} examples")
        except Exception as e:  # keep going with the other models; fail the run at the end
            failed.append((name, repr(e)[:500]))
            print(f"ERROR evaluating {name}: {e!r}")

display(pd.DataFrame(summary))
assert not failed, f"evaluation failed for: {failed}"

# COMMAND ----------

# DBTITLE 1,8. Latest results for this use case
display(spark.sql(f"""
SELECT model_service, metric_name, round(metric_value, 4) AS metric_value, is_headline, passes_threshold, run_id, run_ts
FROM {LATEST_VIEW}
WHERE use_case_id = :u AND is_headline
ORDER BY metric_name, metric_value DESC""", args={"u": USE_CASE_ID}))

# COMMAND ----------

