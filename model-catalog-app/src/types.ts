// Shapes returned by the FastAPI backend (snake_case = straight from SQL).

export interface Threshold { direction: 'gte' | 'lte'; value: number }

export interface UseCase {
  use_case_id: string;
  display_name: string;
  gold_table: string;
  headline_metrics: string[];
  metrics: string[];
  thresholds: Record<string, Threshold>;
  daily_volume: number;
}

export interface Model {
  name: string;
  full_name: string;
  provider: string | null;
  underlying_model: string | null;
  version: string | null;
  capability_tier: string | null;
  status: string | null;
  hosting_type: string | null;
  data_residency: string | null;
  cost_tier: string | null;
  owner: string | null;
  licence_type: string | null;
  pii_allowed: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_refreshed_at: string | null;
  usd_per_1m_input_tokens: number | null;
  usd_per_1m_output_tokens: number | null;
  dbu_per_1m_input_tokens: number | null;
  dbu_per_1m_output_tokens: number | null;
  usd_per_dbu: number | null;
  price_sku: string | null;
  price_source: string | null;
  licence_url: string | null;
  context_window: number | null;
  description: string | null;
  inference_table: string | null;
  supported_api_types: string[] | null;
  tags: Record<string, string> | null;
  approved_use_cases: string[];
}

export interface BenchSummary {
  model_service: string;
  use_case_id: string;
  run_ts: string;
  run_id: string;
  dataset_version: string | null;
  sample_size: number | null;
  judge_model: string | null;
  thresholds_total: number;
  thresholds_passed: number;
  thresholds_failed: number;
  thresholds_unknown: number;
  primary_metric: string;
  primary_value: number | null;
  p95_ms: number | null;
  cost_per_1k: number | null;
  monthly_cost: number | null;
  error_rate: number | null;
}

export interface CatalogData { useCases: UseCase[]; models: Model[]; summary: BenchSummary[] }

export interface MetricRow {
  model_service: string;
  use_case_id: string;
  run_id: string;
  run_ts: string;
  dataset_version: string | null;
  metric_name: string;
  metric_value: number | null;
  is_headline: boolean;
  passes_threshold: boolean | null;
  threshold_direction: 'gte' | 'lte' | null;
  threshold_value: number | null;
  sample_size: number | null;
  judge_model: string | null;
  price_source: string | null;
  mlflow_run_id: string | null;
}

export interface ExampleRow {
  model_service: string;
  use_case_id: string;
  run_id: string;
  record_id: string;
  model_input: string | null;
  model_output: string | null;
  parsed_output: string | null;
  expected: string | null;
  judge_rationale: Record<string, string> | null;
  scores: Record<string, number> | null;
  json_valid: boolean | null;
  error: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface RunHistory {
  run_id: string; use_case_id: string; run_ts: string; sample_size: number | null;
  dataset_version: string | null; judge_model: string | null; primary_metric: string;
  primary_value: number | null; thresholds_failed: number; thresholds_total: number;
}

export interface UsageDay { day: string; requests: number; errors: number; p95_ms: number | null; requesters: number }

export type IntakeStatus = 'submitted' | 'approved' | 'rejected' | 'info_requested' | 'deployed';

export interface IntakeForm {
  project: string;
  environment: 'Lab' | 'Prod';
  cost_centre: string;
  use_case_type: string;
  use_case_id: string | null;
  business_objective: string;
  input_data_source: string;
  input_format: string;
  input_volume: string;
  expected_outcome: string;
  quality_criteria: string;
  latency_requirement: string;
  cost_sensitivity: string;
  ground_truth_availability: string;
  regulatory_considerations: string;
  shortlisted_models: string[];
}

export interface IntakeRequest extends Omit<IntakeForm, 'environment'> {
  request_id: string;
  created_at: string;
  updated_at: string;
  requested_by: string;
  environment: string | null;
  genie_conversation_id: string | null;
  genie_message_id: string | null;
  genie_recommendation: string | null;
  chosen_model: string | null;
  proposed_risk_tier: string | null;
  confirmed_risk_tier: string | null;
  status: IntakeStatus;
  decision_by: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  deployed_at: string | null;
  deployed_by: string | null;
}

export interface GenieAnswer {
  status: string;
  done: boolean;
  text: string;
  error: string | null;
  risk_tier: string | null;
  mentioned_models: string[];
  queries: { title?: string; description?: string; result: { columns: string[]; rows: (string | null)[][] } | null }[];
}

export interface Me { email: string; isGovernance: boolean; hasUserToken: boolean }
