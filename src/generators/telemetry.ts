import type { ActionMetrics } from "../contracts/events.js";
import {
  METRIC_LIMITS,
  NORMAL_BAND_STDDEV,
  type MetricBaseline,
  type PlayerBaseline,
} from "../data/baselines.js";
import type { AnomalyProfile } from "../scenarios/performance-anomaly.js";
import { clamp, round, type Random } from "../simulator/random.js";

type MetricKey = keyof PlayerBaseline;
const METRIC_KEYS: readonly MetricKey[] = [
  "reaction_time_ms",
  "accuracy_pct",
  "headshot_pct",
  "actions_per_minute",
];

/** Slow-moving per-player form offset, so normal play changes gradually rather than jumping. */
export type MetricForm = Record<MetricKey, number>;

export function createForm(): MetricForm {
  return { reaction_time_ms: 0, accuracy_pct: 0, headshot_pct: 0, actions_per_minute: 0 };
}

const FORM_STEP_SD = 0.05;
const FORM_LIMIT_SD = 0.6;

export function driftForm(rng: Random, form: MetricForm, baseline: PlayerBaseline): void {
  for (const key of METRIC_KEYS) {
    const sd = baseline[key].stddev;
    form[key] = clamp(
      form[key] + rng.normal(0, sd * FORM_STEP_SD),
      -sd * FORM_LIMIT_SD,
      sd * FORM_LIMIT_SD,
    );
  }
}

/** The distribution a player's metrics are drawn from, after any anomaly is applied. */
export function effectiveDistribution(
  baseline: PlayerBaseline,
  profile: AnomalyProfile | null,
): PlayerBaseline {
  if (!profile) return baseline;
  return {
    reaction_time_ms: {
      mean: baseline.reaction_time_ms.mean * profile.reaction_mean_mult,
      stddev: baseline.reaction_time_ms.stddev * profile.reaction_sd_mult,
    },
    accuracy_pct: {
      mean: baseline.accuracy_pct.mean + profile.accuracy_add,
      stddev: baseline.accuracy_pct.stddev * profile.accuracy_sd_mult,
    },
    headshot_pct: {
      mean: baseline.headshot_pct.mean + profile.headshot_add,
      stddev: baseline.headshot_pct.stddev * profile.headshot_sd_mult,
    },
    actions_per_minute: {
      mean: baseline.actions_per_minute.mean * profile.apm_mult,
      stddev: baseline.actions_per_minute.stddev,
    },
  };
}

function draw(
  rng: Random,
  dist: MetricBaseline,
  formOffset: number,
  limits: { min: number; max: number },
): number {
  const value = rng.normal(dist.mean + formOffset, dist.stddev);
  const band = dist.stddev * NORMAL_BAND_STDDEV;
  return clamp(clamp(value, dist.mean - band, dist.mean + band), limits.min, limits.max);
}

/**
 * Draws one set of action metrics. Normal values stay within the player's baseline band;
 * anomalous values stay within a band around the shifted distribution. Everything is
 * clamped to the hard metric limits.
 */
export function sampleActionMetrics(
  rng: Random,
  baseline: PlayerBaseline,
  form: MetricForm,
  profile: AnomalyProfile | null,
): ActionMetrics {
  const dist = effectiveDistribution(baseline, profile);
  // Form drift only applies to normal play; an anomaly replaces the player's usual form.
  const f = profile ? createForm() : form;
  return {
    reaction_time_ms: round(
      draw(rng, dist.reaction_time_ms, f.reaction_time_ms, METRIC_LIMITS.reaction_time_ms),
    ),
    accuracy_pct: round(
      draw(rng, dist.accuracy_pct, f.accuracy_pct, METRIC_LIMITS.accuracy_pct),
      1,
    ),
    headshot_pct: round(
      draw(rng, dist.headshot_pct, f.headshot_pct, METRIC_LIMITS.headshot_pct),
      1,
    ),
    actions_per_minute: round(
      draw(rng, dist.actions_per_minute, f.actions_per_minute, METRIC_LIMITS.actions_per_minute),
    ),
  };
}

export function averageMetrics(samples: readonly ActionMetrics[]): ActionMetrics | null {
  if (samples.length === 0) return null;
  const sum = { reaction_time_ms: 0, accuracy_pct: 0, headshot_pct: 0, actions_per_minute: 0 };
  for (const s of samples) {
    for (const key of METRIC_KEYS) sum[key] += s[key];
  }
  const n = samples.length;
  return {
    reaction_time_ms: round(sum.reaction_time_ms / n),
    accuracy_pct: round(sum.accuracy_pct / n, 1),
    headshot_pct: round(sum.headshot_pct / n, 1),
    actions_per_minute: round(sum.actions_per_minute / n),
  };
}
