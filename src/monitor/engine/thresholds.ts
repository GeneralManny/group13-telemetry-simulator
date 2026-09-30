import { z } from "zod";

/**
 * Every tunable number in the risk engine lives here, so a threshold is changed in one place
 * (and can be overridden at runtime through the settings table) instead of being buried in
 * several workflows.
 */
export const ThresholdsSchema = z.object({
  /** Rolling window of a player's recent actions, in match-clock seconds. */
  window_seconds: z.number().positive(),
  /** Fewer samples than this in the window and the performance rules stay silent. */
  min_samples: z.number().int().min(1),
  /** How far (in baseline standard deviations) a window average must move to trigger a rule. */
  trigger_sd: z.number().positive(),
  /** Deviation at which a rule earns its full points. Points scale linearly up to here. */
  full_points_sd: z.number().positive(),
  /** Maximum points per performance rule. Their sum is capped by performance_max. */
  points: z.object({
    reaction_time_ms: z.number().min(0),
    accuracy_pct: z.number().min(0),
    headshot_pct: z.number().min(0),
    actions_per_minute: z.number().min(0),
  }),
  performance_max: z.number().min(0),
  /** An odds move at or above this percentage with no match event nearby is unexplained. */
  odds_trigger_pct: z.number().positive(),
  /** Move at which the odds rule earns its full points. */
  odds_full_pct: z.number().positive(),
  odds_max: z.number().min(0),
  /** A round event within this many seconds explains an odds move. */
  odds_explained_gap_seconds: z.number().min(0),
  /** How close (match clock) an odds move and a performance change must be to combine. */
  correlation_seconds: z.number().min(0),
  cluster_points: z.number().min(0),
  severity: z.object({
    monitor: z.number().int(),
    high: z.number().int(),
    critical: z.number().int(),
  }),
});

export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const DEFAULT_THRESHOLDS: Thresholds = {
  window_seconds: 30,
  min_samples: 4,
  trigger_sd: 2.5,
  full_points_sd: 4,
  points: { reaction_time_ms: 25, accuracy_pct: 15, headshot_pct: 15, actions_per_minute: 5 },
  performance_max: 60,
  odds_trigger_pct: 20,
  odds_full_pct: 30,
  odds_max: 30,
  odds_explained_gap_seconds: 5,
  correlation_seconds: 60,
  cluster_points: 10,
  severity: { monitor: 30, high: 60, critical: 80 },
};

export type Severity = "normal" | "monitor" | "high" | "critical";

export const SEVERITY_RANK: Record<Severity, number> = {
  normal: 0,
  monitor: 1,
  high: 2,
  critical: 3,
};

export function severityFor(score: number, t: Thresholds): Severity {
  if (score >= t.severity.critical) return "critical";
  if (score >= t.severity.high) return "high";
  if (score >= t.severity.monitor) return "monitor";
  return "normal";
}
