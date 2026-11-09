"""Every SQL statement the app runs. Nothing else in the app builds SQL.

Reads come from serverless_nv91sa_catalog.model_catalog; the ONLY table written is
intake_requests. All statements run on the SQL warehouse as the signed-in user
(on-behalf-of-user), so Unity Catalog permissions apply per user. Values are
always bound as named parameters (:name); only the schema name is formatted in.
"""
import os

CATALOG = os.environ.get("MC_CATALOG", "serverless_nv91sa_catalog")
SCHEMA = os.environ.get("MC_SCHEMA", "model_catalog")
S = f"{CATALOG}.{SCHEMA}"

# ---------------------------------------------------------------- reference data
USE_CASES = f"""
SELECT use_case_id, display_name, gold_table, headline_metrics, metrics,
       to_json(thresholds) AS thresholds_json, daily_volume
FROM {S}.use_case_config
ORDER BY use_case_id
"""

# Active model services plus the use cases they are approved for: the
# approved_use_cases tag (comma-separated) unioned with approved intake requests,
# so an approval shows up immediately even before the nightly tag refresh.
MODELS = f"""
WITH approved AS (
  SELECT chosen_model AS name, collect_set(use_case_id) AS from_intake
  FROM {S}.intake_requests
  WHERE status IN ('approved', 'deployed') AND use_case_id IS NOT NULL AND chosen_model IS NOT NULL
  GROUP BY chosen_model
)
SELECT m.name, m.full_name, m.provider, m.underlying_model, m.version, m.capability_tier, m.status,
       m.hosting_type, m.data_residency, m.cost_tier, m.owner, m.licence_type, m.pii_allowed,
       m.first_seen_at AS created_at, m.updated_at, m.last_refreshed_at,
       m.usd_per_1m_input_tokens, m.usd_per_1m_output_tokens, m.dbu_per_1m_input_tokens,
       m.dbu_per_1m_output_tokens, m.usd_per_dbu, m.price_sku, m.price_source,
       m.licence_url, m.context_window, m.description, m.inference_table, m.supported_api_types, m.tags,
       array_distinct(concat(
         coalesce(filter(transform(split(m.tags['approved_use_cases'], ','), x -> trim(x)), x -> x <> ''),
                  CAST(array() AS ARRAY<STRING>)),
         coalesce(a.from_intake, CAST(array() AS ARRAY<STRING>)))) AS approved_use_cases
FROM {S}.model_services m
LEFT JOIN approved a ON a.name = m.name
WHERE m.is_active AND (:model IS NULL OR m.name = :model)
ORDER BY CASE m.capability_tier WHEN 'frontier' THEN 1 WHEN 'mid' THEN 2 ELSE 3 END, m.name
"""

# ---------------------------------------------------------------- benchmarks
# One row per model x use case from the latest run (v_latest_results), with the
# primary metric (use_case_config.headline_metrics[0]), p95, cost and threshold counts.
BENCH_SUMMARY = f"""
WITH uc AS (SELECT use_case_id, headline_metrics FROM {S}.use_case_config)
SELECT r.model_service, r.use_case_id,
       max(r.run_ts) AS run_ts, max(r.run_id) AS run_id, max(r.dataset_version) AS dataset_version,
       max(r.sample_size) AS sample_size, max(r.judge_model) AS judge_model,
       count_if(r.threshold_value IS NOT NULL) AS thresholds_total,
       count_if(r.passes_threshold = true) AS thresholds_passed,
       count_if(r.passes_threshold = false) AS thresholds_failed,
       count_if(r.threshold_value IS NOT NULL AND r.passes_threshold IS NULL) AS thresholds_unknown,
       max(uc.headline_metrics[0]) AS primary_metric,
       max(CASE WHEN r.metric_name = uc.headline_metrics[0] THEN r.metric_value END) AS primary_value,
       max(CASE WHEN r.metric_name = 'latency_p95_ms' THEN r.metric_value END) AS p95_ms,
       max(CASE WHEN r.metric_name = 'cost_per_1k' THEN r.metric_value END) AS cost_per_1k,
       max(CASE WHEN r.metric_name = 'projected_monthly_cost' THEN r.metric_value END) AS monthly_cost,
       max(CASE WHEN r.metric_name = 'error_rate' THEN r.metric_value END) AS error_rate
FROM {S}.v_latest_results r
JOIN uc ON uc.use_case_id = r.use_case_id
WHERE (:model IS NULL OR r.model_service = :model)
GROUP BY r.model_service, r.use_case_id
"""

# Every metric of the latest run for a set of models (JSON array of names), optionally one use case.
METRICS = f"""
SELECT model_service, use_case_id, run_id, run_ts, dataset_version, metric_name, metric_value,
       is_headline, passes_threshold, threshold_direction, threshold_value, sample_size,
       judge_model, price_source, mlflow_run_id
FROM {S}.v_latest_results
WHERE array_contains(from_json(:models, 'array<string>'), model_service)
  AND (:use_case IS NULL OR use_case_id = :use_case)
ORDER BY use_case_id, model_service, metric_name
"""

_LATEST_RUNS = f"""
  SELECT DISTINCT model_service, use_case_id, run_id
  FROM {S}.v_latest_results
  WHERE use_case_id = :use_case AND array_contains(from_json(:models, 'array<string>'), model_service)
"""

# Record ids that have example outputs in the latest run of any of the models.
EXAMPLE_RECORD_IDS = f"""
SELECT e.record_id, count(DISTINCT e.model_service) AS models_with_output
FROM {S}.benchmark_examples e
JOIN ({_LATEST_RUNS}) l
  ON e.model_service = l.model_service AND e.use_case_id = l.use_case_id AND e.run_id = l.run_id
GROUP BY e.record_id
ORDER BY e.record_id
LIMIT 500
"""

# Example outputs from the latest run; optionally a single record (side-by-side viewer).
# {limit} is an int formatted by db.py callers via int(); never user text.
EXAMPLES = f"""
SELECT e.model_service, e.use_case_id, e.run_id, e.record_id, e.model_input, e.model_output,
       e.parsed_output, e.expected, e.judge_rationale, e.scores, e.json_valid, e.error,
       e.latency_ms, e.input_tokens, e.output_tokens
FROM {S}.benchmark_examples e
JOIN ({_LATEST_RUNS}) l
  ON e.model_service = l.model_service AND e.use_case_id = l.use_case_id AND e.run_id = l.run_id
WHERE (:record_id IS NULL OR e.record_id = :record_id)
ORDER BY e.record_id, e.model_service
LIMIT {{limit}}
"""

# Run history for one model (one row per run x use case).
MODEL_RUN_HISTORY = f"""
WITH uc AS (SELECT use_case_id, headline_metrics FROM {S}.use_case_config)
SELECT r.run_id, r.use_case_id, min(r.run_ts) AS run_ts, max(r.sample_size) AS sample_size,
       max(r.dataset_version) AS dataset_version, max(r.judge_model) AS judge_model,
       max(uc.headline_metrics[0]) AS primary_metric,
       max(CASE WHEN r.metric_name = uc.headline_metrics[0] THEN r.metric_value END) AS primary_value,
       count_if(r.passes_threshold = false) AS thresholds_failed,
       count_if(r.threshold_value IS NOT NULL) AS thresholds_total
FROM {S}.benchmark_results r
JOIN uc ON uc.use_case_id = r.use_case_id
WHERE r.model_service = :model
GROUP BY r.run_id, r.use_case_id
ORDER BY run_ts DESC
LIMIT 100
"""

# Daily traffic from the model service's inference (payload) table, last 30 days.
# :tbl is validated in main.py to be <schema>.mc_<name>_payload before binding.
MODEL_USAGE = """
SELECT CAST(date(event_time) AS STRING) AS day, count(*) AS requests,
       count_if(status_code >= 400) AS errors,
       CAST(percentile_approx(latency_ms, 0.95) AS DOUBLE) AS p95_ms,
       count(DISTINCT requester) AS requesters
FROM IDENTIFIER(:tbl)
WHERE event_time >= current_timestamp() - INTERVAL 30 DAYS
GROUP BY 1
ORDER BY 1
"""

# ---------------------------------------------------------------- intake_requests
_INTAKE_COLS = """
  request_id, created_at, updated_at, requested_by, project, environment, cost_centre, use_case_type,
  use_case_id, business_objective, input_data_source, input_format, input_volume, expected_outcome,
  quality_criteria, latency_requirement, cost_sensitivity, ground_truth_availability,
  regulatory_considerations, shortlisted_models, genie_conversation_id, genie_message_id,
  genie_recommendation, chosen_model, proposed_risk_tier, confirmed_risk_tier, status, decision_by,
  decided_at, decision_comment, deployed_at, deployed_by
"""

# Governance (:is_gov = true) sees every request; everyone else only their own.
INTAKE_LIST = f"""
SELECT {_INTAKE_COLS}
FROM {S}.intake_requests
WHERE (:is_gov OR requested_by = current_user())
  AND (:request_id IS NULL OR request_id = :request_id)
  AND (:model IS NULL OR chosen_model = :model)
ORDER BY created_at DESC
LIMIT 1000
"""

# requested_by is current_user() so it can't be spoofed by the client.
INTAKE_INSERT = f"""
INSERT INTO {S}.intake_requests (
  request_id, created_at, updated_at, requested_by, project, environment, cost_centre, use_case_type,
  use_case_id, business_objective, input_data_source, input_format, input_volume, expected_outcome,
  quality_criteria, latency_requirement, cost_sensitivity, ground_truth_availability,
  regulatory_considerations, shortlisted_models, genie_conversation_id, genie_message_id,
  genie_recommendation, chosen_model, proposed_risk_tier, status)
VALUES (
  :request_id, current_timestamp(), current_timestamp(), current_user(), :project, :environment,
  :cost_centre, :use_case_type, :use_case_id, :business_objective, :input_data_source, :input_format,
  :input_volume, :expected_outcome, :quality_criteria, :latency_requirement, :cost_sensitivity,
  :ground_truth_availability, :regulatory_considerations, from_json(:shortlisted_models, 'array<string>'),
  :genie_conversation_id, :genie_message_id, :genie_recommendation, :chosen_model, :proposed_risk_tier,
  'submitted')
"""

# Governance decision. Only open requests (submitted / info_requested) can be decided.
INTAKE_DECIDE = f"""
UPDATE {S}.intake_requests
SET status = :status,
    confirmed_risk_tier = CASE WHEN :status = 'approved' THEN :risk_tier ELSE confirmed_risk_tier END,
    decision_by = current_user(),
    decided_at = current_timestamp(),
    decision_comment = :comment,
    updated_at = current_timestamp()
WHERE request_id = :request_id AND status IN ('submitted', 'info_requested')
"""

# The requester answers an info request; the request goes back to 'submitted'.
INTAKE_RESPOND = f"""
UPDATE {S}.intake_requests
SET status = 'submitted',
    decision_comment = concat(coalesce(decision_comment, ''), '\n\nResponse from ', current_user(), ': ', :reply),
    updated_at = current_timestamp()
WHERE request_id = :request_id AND status = 'info_requested' AND requested_by = current_user()
"""
