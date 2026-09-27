import type { ScenarioName } from "../contracts/events.js";

interface PresetConfig {
  scenario: ScenarioName;
  seed: number;
  event_rate_per_second: number;
  duration_seconds: number;
  target_player_id?: string;
  anomaly_start_second?: number;
  odds_anomaly_start_second?: number;
}

/**
 * Saved, tested configurations. Use these during demos instead of typing values by hand.
 * Changing a preset changes the demo: do not edit these on demo day.
 */
export const PRESETS = {
  final_demo: {
    scenario: "combined",
    seed: 13027,
    event_rate_per_second: 2,
    duration_seconds: 240,
    target_player_id: "player_07",
    anomaly_start_second: 60,
    odds_anomaly_start_second: 90,
  },
  demo_normal: {
    scenario: "normal",
    seed: 13027,
    event_rate_per_second: 2,
    duration_seconds: 120,
  },
  performance_demo: {
    scenario: "performance_anomaly",
    seed: 13027,
    event_rate_per_second: 2,
    duration_seconds: 300,
    target_player_id: "player_07",
    anomaly_start_second: 90,
  },
  odds_demo: {
    scenario: "odds_integrity",
    seed: 13027,
    event_rate_per_second: 2,
    duration_seconds: 240,
    target_player_id: "player_07",
    odds_anomaly_start_second: 90,
  },
  pipeline_test: {
    scenario: "pipeline_failure",
    seed: 13027,
    event_rate_per_second: 2,
    duration_seconds: 120,
  },
} as const satisfies Record<string, PresetConfig>;

export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as [PresetName, ...PresetName[]];
