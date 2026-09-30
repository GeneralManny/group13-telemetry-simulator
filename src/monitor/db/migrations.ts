/**
 * Schema migrations for the monitor, applied in order and recorded in monitor.schema_migrations.
 * Append only: never edit a migration that has been applied. Each statement is idempotent so a
 * half-applied run can be retried safely. Everything lives in the "monitor" schema so it stays
 * separate from n8n's own tables (schema "n8n") in the same database.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "001_init",
    sql: `
CREATE TABLE IF NOT EXISTS monitor.players (
  player_id     text PRIMARY KEY,
  display_name  text NOT NULL,
  team_id       text NOT NULL,
  role          text NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor.matches (
  match_id          text PRIMARY KEY,
  tournament_id     text,
  simulator_run_id  text,
  scenario          text,
  status            text NOT NULL DEFAULT 'live',
  score_blue        integer NOT NULL DEFAULT 0,
  score_red         integer NOT NULL DEFAULT 0,
  round_number      integer,
  total_rounds      integer,
  match_clock_seconds double precision NOT NULL DEFAULT 0,
  events_stored     integer NOT NULL DEFAULT 0,
  started_at        timestamptz,
  ended_at          timestamptz,
  last_event_at     timestamptz
);

-- event_id is the primary key: re-sending an event can never create a second row.
CREATE TABLE IF NOT EXISTS monitor.events (
  event_id            text PRIMARY KEY,
  event_type          text NOT NULL,
  schema_version      text NOT NULL,
  event_timestamp     timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  tournament_id       text,
  match_id            text NOT NULL,
  round_id            text,
  player_id           text,
  team_id             text,
  sequence_number     integer,
  scenario            text,
  simulator_run_id    text,
  match_clock_seconds double precision NOT NULL DEFAULT 0,
  metrics             jsonb NOT NULL DEFAULT '{}'::jsonb,
  odds                jsonb NOT NULL DEFAULT '{}'::jsonb,
  data                jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id            text
);
CREATE INDEX IF NOT EXISTS events_match_player_clock ON monitor.events (match_id, player_id, match_clock_seconds);
CREATE INDEX IF NOT EXISTS events_match_type_clock ON monitor.events (match_id, event_type, match_clock_seconds);
CREATE INDEX IF NOT EXISTS events_received ON monitor.events (received_at DESC);

CREATE TABLE IF NOT EXISTS monitor.baselines (
  player_id    text NOT NULL REFERENCES monitor.players(player_id),
  metric       text NOT NULL,
  sample_size  integer NOT NULL,
  mean         double precision NOT NULL,
  stddev       double precision NOT NULL,
  min_value    double precision,
  max_value    double precision,
  source       text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, metric)
);

-- One case per match and subject (a player, or the betting market). Repeated anomalies update it.
CREATE TABLE IF NOT EXISTS monitor.cases (
  case_id           text PRIMARY KEY,
  match_id          text NOT NULL,
  subject_key       text NOT NULL,
  subject_type      text NOT NULL,
  player_id         text,
  team_id           text,
  simulator_run_id  text,
  status            text NOT NULL DEFAULT 'open',
  severity          text NOT NULL,
  score             integer NOT NULL,
  peak_score        integer NOT NULL,
  components        jsonb NOT NULL,
  rules             jsonb NOT NULL,
  window_start      double precision,
  window_end        double precision,
  trace_id          text,
  alerted_severity  text,
  alert_status      text NOT NULL DEFAULT 'pending',
  alert_attempts    integer NOT NULL DEFAULT 0,
  alert_error       text,
  alerted_at        timestamptz,
  ai_status         text NOT NULL DEFAULT 'pending',
  ai_summary        text,
  ai_model          text,
  ai_generated_at   timestamptz,
  reviewer          text,
  review_notes      text,
  reviewed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, subject_key)
);
CREATE INDEX IF NOT EXISTS cases_status ON monitor.cases (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS monitor.risk_results (
  id                bigserial PRIMARY KEY,
  event_id          text NOT NULL,
  match_id          text NOT NULL,
  subject_key       text NOT NULL,
  player_id         text,
  status            text NOT NULL,
  score             integer NOT NULL,
  severity          text NOT NULL,
  components        jsonb NOT NULL,
  rules             jsonb NOT NULL,
  source_event_ids  text[] NOT NULL DEFAULT '{}',
  window_start      double precision,
  window_end        double precision,
  case_id           text REFERENCES monitor.cases(case_id) ON DELETE SET NULL,
  trace_id          text,
  calculated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_results_subject ON monitor.risk_results (match_id, subject_key, calculated_at DESC);

-- Evidence links a case to the stored events that produced it. Kept after review.
CREATE TABLE IF NOT EXISTS monitor.evidence (
  case_id     text NOT NULL REFERENCES monitor.cases(case_id) ON DELETE CASCADE,
  event_id    text NOT NULL,
  kind        text NOT NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, event_id)
);

CREATE TABLE IF NOT EXISTS monitor.reviews (
  review_id    bigserial PRIMARY KEY,
  case_id      text NOT NULL REFERENCES monitor.cases(case_id) ON DELETE CASCADE,
  action       text NOT NULL,
  reviewer     text NOT NULL,
  notes        text,
  channel      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Every status change on a case, for the audit trail.
CREATE TABLE IF NOT EXISTS monitor.case_audit (
  id           bigserial PRIMARY KEY,
  case_id      text NOT NULL REFERENCES monitor.cases(case_id) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  actor        text NOT NULL,
  note         text,
  at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS monitor.dead_letters (
  id           bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  event_id     text,
  reason       text NOT NULL,
  error        text,
  payload      jsonb,
  trace_id     text,
  retry_status text NOT NULL DEFAULT 'not_retried'
);

-- Every odds update gets one verdict once the explaining window has passed:
-- 'unexplained' (a signal), 'explained' (a round event was close), or 'normal' (small move).
CREATE TABLE IF NOT EXISTS monitor.odds_checks (
  event_id        text PRIMARY KEY,
  match_id        text NOT NULL,
  match_clock     double precision NOT NULL,
  verdict         text NOT NULL,
  movement_pct    double precision NOT NULL,
  shortened_team  text,
  points          integer NOT NULL DEFAULT 0,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS odds_checks_match ON monitor.odds_checks (match_id, verdict, match_clock);

CREATE TABLE IF NOT EXISTS monitor.settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: "002_status_checks",
    sql: `
DO $$ BEGIN
  ALTER TABLE monitor.cases ADD CONSTRAINT cases_status_check
    CHECK (status IN ('open', 'pending_review', 'approved', 'dismissed', 'escalated'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE monitor.cases ADD CONSTRAINT cases_severity_check
    CHECK (severity IN ('normal', 'monitor', 'high', 'critical'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE monitor.reviews ADD CONSTRAINT reviews_action_check
    CHECK (action IN ('approve_for_investigation', 'dismiss', 'escalate'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS cases_match_player ON monitor.cases (match_id, player_id);
CREATE INDEX IF NOT EXISTS cases_severity ON monitor.cases (severity, updated_at DESC);
`,
  },
];
