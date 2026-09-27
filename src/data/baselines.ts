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

/**
 * Stable per-player baselines. Team B builds historical ranges from these, so the
 * values must not change during the sprint.
 */
export const BASELINES: Readonly<Record<string, PlayerBaseline>> = {
  player_01: {
    reaction_time_ms: { mean: 225, stddev: 20 },
    accuracy_pct: { mean: 47, stddev: 5 },
    headshot_pct: { mean: 30, stddev: 6 },
    actions_per_minute: { mean: 150, stddev: 16 },
  },
  player_02: {
    reaction_time_ms: { mean: 240, stddev: 24 },
    accuracy_pct: { mean: 43, stddev: 6 },
    headshot_pct: { mean: 24, stddev: 6 },
    actions_per_minute: { mean: 160, stddev: 20 },
  },
  player_03: {
    reaction_time_ms: { mean: 250, stddev: 25 },
    accuracy_pct: { mean: 40, stddev: 6 },
    headshot_pct: { mean: 20, stddev: 5 },
    actions_per_minute: { mean: 135, stddev: 15 },
  },
  player_04: {
    reaction_time_ms: { mean: 215, stddev: 18 },
    accuracy_pct: { mean: 52, stddev: 5 },
    headshot_pct: { mean: 38, stddev: 7 },
    actions_per_minute: { mean: 120, stddev: 14 },
  },
  player_05: {
    reaction_time_ms: { mean: 235, stddev: 21 },
    accuracy_pct: { mean: 45, stddev: 6 },
    headshot_pct: { mean: 27, stddev: 6 },
    actions_per_minute: { mean: 140, stddev: 17 },
  },
  player_06: {
    reaction_time_ms: { mean: 228, stddev: 21 },
    accuracy_pct: { mean: 46, stddev: 5 },
    headshot_pct: { mean: 28, stddev: 6 },
    actions_per_minute: { mean: 155, stddev: 18 },
  },
  player_07: {
    reaction_time_ms: { mean: 230, stddev: 22 },
    accuracy_pct: { mean: 46, stddev: 6 },
    headshot_pct: { mean: 29, stddev: 7 },
    actions_per_minute: { mean: 145, stddev: 18 },
  },
  player_08: {
    reaction_time_ms: { mean: 245, stddev: 23 },
    accuracy_pct: { mean: 42, stddev: 6 },
    headshot_pct: { mean: 22, stddev: 5 },
    actions_per_minute: { mean: 138, stddev: 15 },
  },
  player_09: {
    reaction_time_ms: { mean: 212, stddev: 17 },
    accuracy_pct: { mean: 53, stddev: 5 },
    headshot_pct: { mean: 40, stddev: 7 },
    actions_per_minute: { mean: 118, stddev: 13 },
  },
  player_10: {
    reaction_time_ms: { mean: 238, stddev: 22 },
    accuracy_pct: { mean: 44, stddev: 6 },
    headshot_pct: { mean: 26, stddev: 6 },
    actions_per_minute: { mean: 142, stddev: 16 },
  },
};

/** Hard limits applied to every generated value, normal or anomalous. */
export const METRIC_LIMITS = {
  reaction_time_ms: { min: 80, max: 600 },
  accuracy_pct: { min: 0, max: 100 },
  headshot_pct: { min: 0, max: 100 },
  actions_per_minute: { min: 20, max: 400 },
} as const;

/** Normal play is kept within this many standard deviations of the baseline mean. */
export const NORMAL_BAND_STDDEV = 2.5;
