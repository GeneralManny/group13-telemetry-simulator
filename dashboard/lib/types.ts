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
