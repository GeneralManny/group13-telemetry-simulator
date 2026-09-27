import type { FastifyInstance } from "fastify";
import { EVENT_TYPES, SCHEMA_VERSION } from "../contracts/events.js";
import { FAULT_TYPES } from "../contracts/validation.js";
import { METRIC_LIMITS } from "../data/baselines.js";
import { PLAYERS } from "../data/players.js";
import { TEAMS } from "../data/teams.js";
import { ODDS_MARGIN } from "../generators/odds.js";
import { SCENARIOS } from "../scenarios/index.js";
import { ANOMALY_PROFILES } from "../scenarios/performance-anomaly.js";
import { PRESETS } from "../scenarios/presets.js";
import type { SimulatorEngine } from "../simulator/engine.js";

export function registerStatusRoutes(
  app: FastifyInstance,
  deps: { engine: SimulatorEngine },
): void {
  app.get("/api/v1/status", async () => deps.engine.status());

  app.get<{ Querystring: { player?: string } }>("/api/v1/timeline", async (req) =>
    deps.engine.timeline(req.query.player),
  );

  app.get("/api/v1/scenarios", async () => ({
    schema_version: SCHEMA_VERSION,
    scenarios: Object.values(SCENARIOS).map((s) => ({
      name: s.name,
      title: s.title,
      purpose: s.purpose,
      expected_downstream_result: s.expected_downstream_result,
      performance_anomaly: s.performanceAnomaly,
      odds_anomaly: s.oddsAnomaly,
      defaults: {
        ...s.defaults,
        ...(s.defaultFailureModes ? { failure_modes: s.defaultFailureModes } : {}),
      },
    })),
    presets: PRESETS,
    options: {
      scenario: "required unless preset is given",
      preset: Object.keys(PRESETS),
      seed: "integer 0-4294967295; random if omitted (returned in the response for replay)",
      event_rate_per_second: "0.1-50, default from DEFAULT_EVENT_RATE",
      duration_seconds: "10-7200, default from DEFAULT_MATCH_DURATION_SECONDS",
      round_duration_seconds: "5-600, default 25 (adjusted so rounds divide the match evenly)",
      target_player_id: PLAYERS.map((p) => p.player_id),
      anomaly_start_second: "match second the performance anomaly begins",
      anomaly_duration_seconds: "optional; default lasts until the match ends",
      anomaly_direction: Object.keys(ANOMALY_PROFILES),
      odds_anomaly_start_second:
        "match second of the sharp odds movement (moved up to 3 s away from round boundaries)",
      odds_anomaly_movement_pct: "5-200, default 30",
      odds_anomaly_direction:
        "toward | against the target player's team; default toward for over, against for under",
      webhook_url: "configured-default | none | https URL",
      match_id: "optional; default match_<run token>",
      failure_modes: {
        faults: FAULT_TYPES,
        burst: "boolean",
        rate: "0-1, default 0.08",
        delay_ms: "default 8000",
        stale_by_seconds: "default 600",
        burst_start_second: "default 30",
        burst_duration_seconds: "default 10",
        burst_multiplier: "2-20, default 5",
      },
      emit_status_events: "boolean, default false",
    },
    event_types: EVENT_TYPES,
    reference: {
      odds_margin: ODDS_MARGIN,
      normal_odds_movement: "periodic market updates move under ~3%; round results under ~15%",
      metric_limits: METRIC_LIMITS,
    },
  }));

  app.get("/api/v1/players", async () => ({
    teams: TEAMS.map((t) => ({ team_id: t.team_id, name: t.name, short_name: t.short_name })),
    players: PLAYERS,
    notes:
      "Baselines are stable for the sprint. Normal play stays within mean +/- 2.5 stddev and drifts gradually.",
  }));
}
