export type RunState = "idle" | "running" | "paused" | "stopped" | "completed" | "failed";
export type Health = "healthy" | "degraded" | "failing" | "unknown" | "disabled";
export type Role = "admin" | "team" | null;
export type TeamId = "team_blue" | "team_red";

export interface Score {
  team_blue: number;
  team_red: number;
}

export interface MatchProgress {
  match_clock_seconds: number;
  duration_seconds: number;
  round_number: number;
  total_rounds: number;
  score: Score;
  finished: boolean;
}

export interface Status {
  service: string;
  version: string;
  schema_version: string;
  status: RunState;
  run_id: string | null;
  last_run_id: string | null;
  scenario: string | null;
  preset: string | null;
  seed: number | null;
  replay_of: string | null;
  events_generated: number;
  events_delivered: number;
  events_failed: number;
  events_pending: number;
  events_dropped: number;
  events_skipped: number;
  delivery_retries: number;
  last_event_at: string | null;
  last_response_code: number | null;
  webhook_status: Health;
  webhook_target: {
    mode: string;
    host: string | null;
    token_configured: boolean;
    destinations: number;
  };
  match: MatchProgress | null;
  failure_modes_enabled: boolean;
  started_at: string | null;
  ended_at: string | null;
  error: string | null;
  server_time: string;
}

export interface Session {
  role: Role;
  open: boolean;
  can_control_runs: boolean;
  can_manage_webhooks: boolean;
  can_review_cases?: boolean;
}

export interface MetricBaseline {
  mean: number;
  stddev: number;
}

export interface PlayerBaseline {
  reaction_time_ms: MetricBaseline;
  accuracy_pct: MetricBaseline;
  headshot_pct: MetricBaseline;
  actions_per_minute: MetricBaseline;
}

export interface Player {
  player_id: string;
  display_name: string;
  team_id: TeamId;
  role: string;
  baseline: PlayerBaseline;
}

export interface SamplePoint {
  t: number;
  reaction_time_ms: number;
  accuracy_pct: number;
  headshot_pct: number;
  actions_per_minute: number;
}

export interface OddsPoint {
  t: number;
  seq: number;
  team_blue: number;
  team_red: number;
  movement_pct: number;
  reason: string;
}

export interface Snapshot {
  player_id: string;
  display_name: string;
  team_id: TeamId;
  baseline: PlayerBaseline;
  latest: { t: number; metrics: Record<string, number> } | null;
}

export interface Timeline {
  run_id: string | null;
  status: RunState;
  match: (MatchProgress & { round_length_seconds: number }) | null;
  odds: OddsPoint[];
  rounds: { t: number; round_number: number; winner_team_id: TeamId }[];
  snapshots: Snapshot[];
  player: {
    player_id: string;
    display_name: string;
    team_id: TeamId;
    baseline: PlayerBaseline;
    samples: SamplePoint[];
  };
}

export interface ScenarioInfo {
  name: string;
  title: string;
  purpose: string;
  expected_downstream_result: string;
  performance_anomaly: boolean;
  odds_anomaly: boolean;
}

export interface ScenarioCatalog {
  scenarios: ScenarioInfo[];
  presets: Record<string, Record<string, string | number>>;
  event_types: string[];
}

export interface DeliveryStats {
  attempts: number;
  delivered: number;
  failed: number;
  retries: number;
  last_status_code: number | null;
  last_error: string | null;
  last_attempt_at: string | null;
  last_delivery_at: string | null;
  health: Health;
}

export interface Destination {
  id: string;
  name: string;
  source: "environment" | "dashboard";
  host: string;
  url_display: string;
  enabled: boolean;
  event_types: string[] | null;
  token_set: boolean;
  created_at: string | null;
  delivery: DeliveryStats;
}

export interface EmittedEvent {
  emitted_at: string;
  fault: string | null;
  payload: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Monitor (integrity cases)

export type Severity = "normal" | "monitor" | "high" | "critical";
export type CaseStatus = "open" | "pending_review" | "approved" | "dismissed" | "escalated";
export type ReviewAction = "approve_for_investigation" | "dismiss" | "escalate";

export interface RuleHit {
  rule_id: string;
  component: "performance" | "odds" | "cluster";
  points: number;
  description: string;
  metric?: string;
  observed?: number;
  baseline_mean?: number;
  baseline_stddev?: number;
  deviation_sd?: number;
  direction?: "above" | "below";
  sample_count?: number;
  movement_pct?: number;
  seconds_apart?: number;
  source_event_ids: string[];
}

export interface CaseSummary {
  case_id: string;
  match_id: string;
  subject_type: "player" | "market";
  player_id: string | null;
  display_name: string | null;
  team_id: TeamId | null;
  status: CaseStatus;
  severity: Severity;
  score: number;
  peak_score: number;
  alert_status: string;
  ai_status: string;
  reviewer: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  window_start: number | null;
  window_end: number | null;
  rule_ids: string[] | null;
}

export interface EvidencePacket {
  case_id: string;
  severity: Severity;
  score: number;
  status: CaseStatus;
  match: {
    match_id: string;
    simulator_run_id: string | null;
    match_clock_seconds: number;
    score: Score;
  };
  subject:
    | { type: "player"; player_id: string; display_name: string; team_id: TeamId }
    | { type: "market" };
  components: { performance: number; odds: number; cluster: number };
  rules: RuleHit[];
  window: { start: number | null; end: number | null };
  metrics_vs_baseline: {
    metric: string;
    baseline_mean: number;
    baseline_stddev: number;
    baseline_sample_size: number;
    window_average: number | null;
    deviation_sd: number | null;
  }[];
  odds_moves: {
    event_id: string;
    match_clock: number;
    movement_pct: number;
    shortened_team: TeamId | null;
    from: { team_blue: number; team_red: number } | null;
    to: { team_blue: number; team_red: number } | null;
  }[];
  sample_events: {
    event_id: string;
    match_clock: number;
    event_type: string;
    metrics: Record<string, number>;
  }[];
  evidence_event_count: number;
  case_url: string | null;
}

export interface CaseDetail {
  case: {
    case_id: string;
    status: CaseStatus;
    severity: Severity;
    score: number;
    peak_score: number;
    alert_status: string;
    alert_attempts: number;
    alert_error: string | null;
    alerted_at: string | null;
    ai_status: string;
    ai_summary: string | null;
    ai_model: string | null;
    ai_generated_at: string | null;
    reviewer: string | null;
    review_notes: string | null;
    reviewed_at: string | null;
    created_at: string;
    updated_at: string;
    trace_id: string | null;
  };
  evidence: EvidencePacket;
  score_history: { score: number; severity: Severity; t: number; calculated_at: string }[];
  reviews: {
    action: ReviewAction;
    reviewer: string;
    notes: string | null;
    channel: string;
    created_at: string;
  }[];
  audit: {
    from_status: string | null;
    to_status: string;
    actor: string;
    note: string | null;
    at: string;
  }[];
}

export interface MonitorOverview {
  pipeline: {
    status: "waiting" | "receiving" | "idle";
    events_stored: number;
    events_last_minute: number;
    dead_letters: number;
    last_event_at: string | null;
    ai_configured: boolean;
  };
  match: {
    match_id: string;
    status: string;
    score_blue: number;
    score_red: number;
    round_number: number | null;
    total_rounds: number | null;
    match_clock_seconds: number;
    events_stored: number;
    last_event_at: string;
  } | null;
  cases: Partial<Record<CaseStatus, number>>;
  thresholds: { monitor: number; high: number; critical: number };
}

export interface SubjectRisk {
  subject: string;
  display_name: string;
  team_id: TeamId | null;
  score: number;
  severity: Severity;
  status: string;
  peak_score: number;
  rules: string[];
  updated_at: string | null;
}

export interface DeadLetter {
  id: string;
  received_at: string;
  event_id: string | null;
  reason: string;
  error: string | null;
  trace_id: string | null;
}
