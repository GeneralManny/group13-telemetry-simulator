import { randomInt } from "node:crypto";
import { z } from "zod";
import { PLAYER_IDS } from "../data/players.js";
import { getScenario } from "../scenarios/index.js";
import { PRESETS, PRESET_NAMES, type PresetName } from "../scenarios/presets.js";
import { EVENT_TYPES, SCENARIO_NAMES, SimulatorEventSchema, type ScenarioName } from "./events.js";

export const ANOMALY_DIRECTIONS = ["over", "under"] as const;
export type AnomalyDirection = (typeof ANOMALY_DIRECTIONS)[number];
export type OddsAnomalyDirection = "toward" | "against";

export const FAULT_TYPES = [
  "duplicate",
  "missing_field",
  "malformed",
  "delayed",
  "stale_timestamp",
] as const;
export type FaultType = (typeof FAULT_TYPES)[number];

const WebhookUrlField = z.union([
  z.literal("configured-default"),
  z.literal("none"),
  z.url({ protocol: /^https?$/ }),
]);

const FailureModesRequestSchema = z
  .object({
    duplicate: z.boolean().optional(),
    missing_field: z.boolean().optional(),
    malformed: z.boolean().optional(),
    delayed: z.boolean().optional(),
    stale_timestamp: z.boolean().optional(),
    burst: z.boolean().optional(),
    /** Share of eligible events (actions, combat, snapshots) that receive a fault. */
    rate: z.number().min(0).max(1).optional(),
    delay_ms: z.number().int().min(0).max(120_000).optional(),
    stale_by_seconds: z.number().int().min(1).max(86_400).optional(),
    burst_start_second: z.number().min(0).optional(),
    burst_duration_seconds: z.number().positive().max(600).optional(),
    burst_multiplier: z.number().int().min(2).max(20).optional(),
  })
  .strict();

export interface FailureModes {
  duplicate: boolean;
  missing_field: boolean;
  malformed: boolean;
  delayed: boolean;
  stale_timestamp: boolean;
  burst: boolean;
  rate: number;
  delay_ms: number;
  stale_by_seconds: number;
  burst_start_second: number;
  burst_duration_seconds: number;
  burst_multiplier: number;
}

const FAILURE_MODE_DEFAULTS: FailureModes = {
  duplicate: false,
  missing_field: false,
  malformed: false,
  delayed: false,
  stale_timestamp: false,
  burst: false,
  rate: 0.08,
  delay_ms: 8000,
  stale_by_seconds: 600,
  burst_start_second: 30,
  burst_duration_seconds: 10,
  burst_multiplier: 5,
};

export const StartRunRequestSchema = z
  .object({
    preset: z.enum(PRESET_NAMES).optional(),
    scenario: z.enum(SCENARIO_NAMES).optional(),
    seed: z.number().int().min(0).max(4_294_967_295).optional(),
    event_rate_per_second: z.number().min(0.1).max(50).optional(),
    duration_seconds: z.number().int().min(10).max(7200).optional(),
    round_duration_seconds: z.number().min(5).max(600).optional(),
    target_player_id: z.enum(PLAYER_IDS as [string, ...string[]]).optional(),
    anomaly_start_second: z.number().min(0).optional(),
    anomaly_duration_seconds: z.number().positive().nullable().optional(),
    anomaly_direction: z.enum(ANOMALY_DIRECTIONS).optional(),
    odds_anomaly_start_second: z.number().min(0).optional(),
    odds_anomaly_movement_pct: z.number().min(5).max(200).optional(),
    odds_anomaly_direction: z.enum(["toward", "against"]).optional(),
    webhook_url: WebhookUrlField.optional(),
    match_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, numbers, _ and - only (max 64)")
      .optional(),
    failure_modes: FailureModesRequestSchema.optional(),
    emit_status_events: z.boolean().optional(),
  })
  .strict()
  .refine((r) => r.scenario !== undefined || r.preset !== undefined, {
    message: "Provide either scenario or preset",
    path: ["scenario"],
  });

export type StartRunRequest = z.input<typeof StartRunRequestSchema>;

export interface RunConfigValues {
  scenario: ScenarioName;
  seed: number;
  event_rate_per_second: number;
  duration_seconds: number;
  round_duration_seconds: number;
  target_player_id: string;
  anomaly_start_second: number;
  anomaly_duration_seconds: number | null;
  anomaly_direction: AnomalyDirection;
  odds_anomaly_start_second: number;
  odds_anomaly_movement_pct: number;
  odds_anomaly_direction: OddsAnomalyDirection;
  webhook_url: string;
  match_id: string | null;
  emit_status_events: boolean;
}

/** Fully resolved configuration for one run. Replays reuse this object unchanged. */
export interface RunConfig extends RunConfigValues {
  preset: PresetName | null;
  performance_anomaly_enabled: boolean;
  odds_anomaly_enabled: boolean;
  failure_modes: FailureModes | null;
}

export interface RunDefaults {
  event_rate_per_second: number;
  duration_seconds: number;
}

export class RequestValidationError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export function formatZodIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({
    path: i.path.length ? i.path.join(".") : "(body)",
    message: i.message,
  }));
}

/**
 * Merges, in order: service defaults, scenario defaults, preset values, request values.
 * Throws RequestValidationError with every problem found.
 */
export function resolveRunConfig(
  body: unknown,
  defaults: RunDefaults,
  seedSource: () => number = () => randomInt(0, 2 ** 31),
): RunConfig {
  const parsed = StartRunRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new RequestValidationError("Invalid run configuration", formatZodIssues(parsed.error));
  }
  const request = parsed.data;
  const preset = request.preset ? PRESETS[request.preset] : undefined;
  const scenarioName = (request.scenario ?? preset?.scenario) as ScenarioName;
  const scenario = getScenario(scenarioName);

  const { preset: _preset, failure_modes: requestedFaults, ...requestValues } = request;
  const merged = {
    event_rate_per_second: defaults.event_rate_per_second,
    duration_seconds: defaults.duration_seconds,
    round_duration_seconds: 25,
    target_player_id: "player_07",
    anomaly_start_second: 90,
    anomaly_duration_seconds: null as number | null,
    anomaly_direction: "over" as AnomalyDirection,
    odds_anomaly_start_second: 90,
    odds_anomaly_movement_pct: 30,
    webhook_url: "configured-default",
    match_id: null as string | null,
    emit_status_events: false,
    ...scenario.defaults,
    ...(preset ?? {}),
    ...stripUndefined(requestValues),
    scenario: scenarioName,
  };

  const seed = request.seed ?? preset?.seed ?? seedSource();
  const oddsDirection: OddsAnomalyDirection =
    request.odds_anomaly_direction ?? (merged.anomaly_direction === "over" ? "toward" : "against");

  const failureModes =
    scenario.defaultFailureModes || requestedFaults
      ? {
          ...FAILURE_MODE_DEFAULTS,
          ...scenario.defaultFailureModes,
          ...stripUndefined(requestedFaults ?? {}),
        }
      : null;

  // The default round length shrinks to fit short matches; an explicit value is validated as given.
  if (request.round_duration_seconds === undefined) {
    merged.round_duration_seconds = Math.min(
      merged.round_duration_seconds,
      merged.duration_seconds,
    );
  }

  const config: RunConfig = {
    ...merged,
    seed,
    odds_anomaly_direction: oddsDirection,
    preset: request.preset ?? null,
    performance_anomaly_enabled: scenario.performanceAnomaly,
    odds_anomaly_enabled: scenario.oddsAnomaly,
    failure_modes: failureModes && hasAnyFault(failureModes) ? failureModes : null,
  };

  const issues = crossFieldIssues(config);
  if (issues.length) throw new RequestValidationError("Invalid run configuration", issues);
  return config;
}

function crossFieldIssues(c: RunConfig): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (c.round_duration_seconds > c.duration_seconds) {
    issues.push({
      path: "round_duration_seconds",
      message: `must not exceed duration_seconds (${c.duration_seconds})`,
    });
  }
  if (c.round_duration_seconds * c.event_rate_per_second < 4) {
    issues.push({
      path: "round_duration_seconds",
      message: "round_duration_seconds x event_rate_per_second must be at least 4 events per round",
    });
  }
  if (c.performance_anomaly_enabled && c.anomaly_start_second >= c.duration_seconds) {
    issues.push({
      path: "anomaly_start_second",
      message: `must be less than duration_seconds (${c.duration_seconds})`,
    });
  }
  if (c.odds_anomaly_enabled && c.odds_anomaly_start_second >= c.duration_seconds) {
    issues.push({
      path: "odds_anomaly_start_second",
      message: `must be less than duration_seconds (${c.duration_seconds})`,
    });
  }
  if (c.event_rate_per_second * c.duration_seconds > 250_000) {
    issues.push({
      path: "event_rate_per_second",
      message: "event_rate_per_second x duration_seconds must not exceed 250000 events",
    });
  }
  return issues;
}

function hasAnyFault(f: FailureModes): boolean {
  return f.burst || FAULT_TYPES.some((t) => f[t]);
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const TEST_EVENT_TYPES = [
  "player_action",
  "combat_event",
  "player_snapshot",
  "odds_update",
] as const satisfies readonly (typeof EVENT_TYPES)[number][];

export const TestEventRequestSchema = z
  .object({
    event_type: z.enum(TEST_EVENT_TYPES).default("player_action"),
    fault: z.enum(["none", "missing_field", "malformed", "stale_timestamp"]).default("none"),
    webhook_url: WebhookUrlField.default("configured-default"),
  })
  .strict();

export type TestEventRequest = z.infer<typeof TestEventRequestSchema>;

export function validateEvent(event: unknown) {
  return SimulatorEventSchema.safeParse(event);
}
