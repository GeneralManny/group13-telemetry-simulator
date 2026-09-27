import { z } from "zod";

/**
 * Event contract, schema version 1.0. FROZEN for the sprint: fields may be added as
 * optional, but required fields must never be renamed or removed.
 */
export const SCHEMA_VERSION = "1.0" as const;

export const EVENT_TYPES = [
  "match_started",
  "round_started",
  "player_action",
  "combat_event",
  "player_snapshot",
  "odds_update",
  "round_ended",
  "match_ended",
  "simulator_status",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SCENARIO_NAMES = [
  "normal",
  "performance_anomaly",
  "odds_integrity",
  "combined",
  "pipeline_failure",
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** Scenario label carried by events. `integration_test` is used by the single test-event endpoint. */
export const EVENT_SCENARIO_LABELS = [...SCENARIO_NAMES, "integration_test"] as const;
export type EventScenarioLabel = (typeof EVENT_SCENARIO_LABELS)[number];

export const REQUIRED_ENVELOPE_FIELDS = [
  "event_id",
  "event_type",
  "schema_version",
  "timestamp",
  "tournament_id",
  "match_id",
  "round_id",
  "player_id",
  "team_id",
  "sequence_number",
  "scenario",
  "simulator_run_id",
  "metrics",
  "odds",
  "data",
  "metadata",
] as const;

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const IsoUtcTimestamp = z
  .string()
  .regex(ISO_UTC_MS, "must be an ISO 8601 UTC timestamp such as 2026-09-27T12:00:00.000Z")
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be a real date");

const TeamIdSchema = z.enum(["team_blue", "team_red"]);
const Empty = z.object({}).strict();

export const ScoreSchema = z.object({
  team_blue: z.number().int().min(0),
  team_red: z.number().int().min(0),
});

export const ActionMetricsSchema = z.object({
  reaction_time_ms: z.number().min(0),
  accuracy_pct: z.number().min(0).max(100),
  headshot_pct: z.number().min(0).max(100),
  actions_per_minute: z.number().min(0),
});

export const PlayerMetricsSchema = ActionMetricsSchema.extend({
  kills: z.number().int().min(0),
  deaths: z.number().int().min(0),
  assists: z.number().int().min(0),
  damage: z.number().int().min(0),
});

export const OddsSchema = z.object({
  provider: z.literal("simulator"),
  market: z.literal("match_winner"),
  team_blue: z.number().min(1),
  team_red: z.number().min(1),
  previous_team_blue: z.number().min(1),
  previous_team_red: z.number().min(1),
  /** Largest absolute percentage change of either team's odds versus the previous update. */
  movement_pct: z.number().min(0),
  market_timestamp: IsoUtcTimestamp,
});

export const OddsReasonSchema = z.enum(["match_start", "round_result", "market_update"]);

export const PlayerSummarySchema = z.object({
  player_id: z.string(),
  team_id: TeamIdSchema,
  kills: z.number().int().min(0),
  deaths: z.number().int().min(0),
  assists: z.number().int().min(0),
  damage: z.number().int().min(0),
});

export const MatchPlayerSummarySchema = PlayerSummarySchema.extend({
  avg_reaction_time_ms: z.number().nullable(),
  avg_accuracy_pct: z.number().nullable(),
  avg_headshot_pct: z.number().nullable(),
  avg_actions_per_minute: z.number().nullable(),
});

export const MetadataSchema = z.object({
  map: z.string(),
  source: z.string(),
  simulator_version: z.string(),
  /** Simulated match clock in seconds. Unaffected by pauses, so it is safe for rolling windows. */
  match_clock_seconds: z.number().min(0),
});

const envelope = {
  event_id: z.string().min(1),
  schema_version: z.literal(SCHEMA_VERSION),
  timestamp: IsoUtcTimestamp,
  tournament_id: z.string().min(1),
  match_id: z.string().min(1),
  round_id: z.string().nullable(),
  player_id: z.string().nullable(),
  team_id: TeamIdSchema.nullable(),
  sequence_number: z.number().int().positive(),
  scenario: z.enum(EVENT_SCENARIO_LABELS),
  simulator_run_id: z.string().min(1),
  metrics: z.object({}),
  odds: z.object({}),
  data: z.object({}),
  metadata: MetadataSchema,
};

const RosterPlayer = z.object({
  player_id: z.string(),
  display_name: z.string(),
  role: z.string(),
});

export const MatchStartedEvent = z.object({
  ...envelope,
  event_type: z.literal("match_started"),
  round_id: z.null(),
  player_id: z.null(),
  team_id: z.null(),
  metrics: Empty,
  odds: Empty,
  data: z.object({
    teams: z.array(
      z.object({
        team_id: TeamIdSchema,
        name: z.string(),
        players: z.array(RosterPlayer),
      }),
    ),
    map: z.string(),
    scheduled_duration_seconds: z.number().positive(),
    total_rounds: z.number().int().positive(),
    round_duration_seconds: z.number().positive(),
    started_at: IsoUtcTimestamp,
  }),
});

export const RoundStartedEvent = z.object({
  ...envelope,
  event_type: z.literal("round_started"),
  round_id: z.string(),
  player_id: z.null(),
  team_id: z.null(),
  metrics: Empty,
  odds: Empty,
  data: z.object({
    round_number: z.number().int().positive(),
    score: ScoreSchema,
    active_players: z.array(z.string()),
  }),
});

export const PlayerActionEvent = z.object({
  ...envelope,
  event_type: z.literal("player_action"),
  round_id: z.string(),
  player_id: z.string(),
  team_id: TeamIdSchema,
  metrics: ActionMetricsSchema,
  odds: Empty,
  data: z.object({
    action_type: z.enum(["aim", "peek", "move", "reload", "ability", "utility"]),
    position: z.object({ x: z.number(), y: z.number() }),
  }),
});

export const CombatEvent = z.object({
  ...envelope,
  event_type: z.literal("combat_event"),
  round_id: z.string(),
  player_id: z.string(),
  team_id: TeamIdSchema,
  metrics: z.object({
    damage: z.number().int().min(0),
    reaction_time_ms: z.number().min(0),
  }),
  odds: Empty,
  data: z.object({
    result: z.enum(["damage", "kill"]),
    target_player_id: z.string(),
    target_team_id: TeamIdSchema,
    weapon: z.string(),
    headshot: z.boolean(),
    assist_player_id: z.string().nullable(),
  }),
});

export const PlayerSnapshotEvent = z.object({
  ...envelope,
  event_type: z.literal("player_snapshot"),
  round_id: z.string(),
  player_id: z.string(),
  team_id: TeamIdSchema,
  metrics: PlayerMetricsSchema,
  odds: Empty,
  data: z.object({
    window_seconds: z.number().positive(),
    sample_count: z.number().int().min(0),
    round_number: z.number().int().positive(),
  }),
});

export const OddsUpdateEvent = z.object({
  ...envelope,
  event_type: z.literal("odds_update"),
  player_id: z.null(),
  team_id: z.null(),
  metrics: Empty,
  odds: OddsSchema,
  data: z.object({
    reason: OddsReasonSchema,
    score: ScoreSchema,
  }),
});

export const RoundEndedEvent = z.object({
  ...envelope,
  event_type: z.literal("round_ended"),
  round_id: z.string(),
  player_id: z.null(),
  team_id: z.null(),
  metrics: Empty,
  odds: Empty,
  data: z.object({
    round_number: z.number().int().positive(),
    winner_team_id: TeamIdSchema,
    score: ScoreSchema,
    player_summaries: z.array(PlayerSummarySchema),
  }),
});

export const MatchEndedEvent = z.object({
  ...envelope,
  event_type: z.literal("match_ended"),
  round_id: z.null(),
  player_id: z.null(),
  team_id: z.null(),
  metrics: Empty,
  odds: Empty,
  data: z.object({
    winner_team_id: TeamIdSchema,
    final_score: ScoreSchema,
    total_rounds: z.number().int().positive(),
    duration_seconds: z.number().min(0),
    player_summaries: z.array(MatchPlayerSummarySchema),
  }),
});

export const SimulatorStatusEvent = z.object({
  ...envelope,
  event_type: z.literal("simulator_status"),
  player_id: z.null(),
  team_id: z.null(),
  metrics: Empty,
  odds: Empty,
  data: z.object({
    run_state: z.string(),
    events_generated: z.number().int().min(0),
  }),
});

export const SimulatorEventSchema = z.discriminatedUnion("event_type", [
  MatchStartedEvent,
  RoundStartedEvent,
  PlayerActionEvent,
  CombatEvent,
  PlayerSnapshotEvent,
  OddsUpdateEvent,
  RoundEndedEvent,
  MatchEndedEvent,
  SimulatorStatusEvent,
]);

export type SimulatorEvent = z.infer<typeof SimulatorEventSchema>;
export type ActionMetrics = z.infer<typeof ActionMetricsSchema>;
export type PlayerMetrics = z.infer<typeof PlayerMetricsSchema>;
export type OddsData = z.infer<typeof OddsSchema>;
export type OddsReason = z.infer<typeof OddsReasonSchema>;
export type Score = z.infer<typeof ScoreSchema>;
export type PlayerSummary = z.infer<typeof PlayerSummarySchema>;
export type MatchPlayerSummary = z.infer<typeof MatchPlayerSummarySchema>;
