import type { AnomalyDirection } from "../contracts/validation.js";
import type { ScenarioDefinition } from "./types.js";

export const performanceAnomalyScenario: ScenarioDefinition = {
  name: "performance_anomaly",
  title: "Performance anomaly",
  purpose:
    "Trigger explainable performance rules: the selected player's reaction time drops sharply " +
    "and accuracy/headshot rate rise above their historical range, repeatedly, from a known second.",
  expected_downstream_result: "High or critical performance-risk case for the selected player.",
  performanceAnomaly: true,
  oddsAnomaly: false,
  defaults: { anomaly_start_second: 90, anomaly_direction: "over" },
};

/** How the selected player's distribution is changed while the anomaly is active. */
export interface AnomalyProfile {
  reaction_mean_mult: number;
  reaction_sd_mult: number;
  accuracy_add: number;
  accuracy_sd_mult: number;
  headshot_add: number;
  headshot_sd_mult: number;
  apm_mult: number;
  /** Relative chance of the player appearing in action events (keeps rolling windows full). */
  activity_weight: number;
  /** Relative chance of the player being the attacker when their team wins a fight. */
  actor_weight: number;
  /** Relative chance of the player being the victim when their team loses a fight. */
  victim_weight: number;
  /** Change in the chance that the player's team wins any given fight. */
  fight_win_shift: number;
}

export const ANOMALY_PROFILES: Readonly<Record<AnomalyDirection, AnomalyProfile>> = {
  // Overperformance: far faster and more accurate than baseline. ~115 ms reactions, ~80% accuracy for player_07.
  over: {
    reaction_mean_mult: 0.5,
    reaction_sd_mult: 0.4,
    accuracy_add: 34,
    accuracy_sd_mult: 0.5,
    headshot_add: 38,
    headshot_sd_mult: 0.6,
    apm_mult: 1.05,
    activity_weight: 3,
    actor_weight: 3,
    victim_weight: 0.5,
    fight_win_shift: 0.1,
  },
  // Underperformance: far slower and less accurate than baseline, and dies more often.
  under: {
    reaction_mean_mult: 1.45,
    reaction_sd_mult: 1.2,
    accuracy_add: -22,
    accuracy_sd_mult: 0.8,
    headshot_add: -17,
    headshot_sd_mult: 0.8,
    apm_mult: 0.75,
    activity_weight: 3,
    actor_weight: 0.5,
    victim_weight: 3,
    fight_win_shift: -0.1,
  },
};
