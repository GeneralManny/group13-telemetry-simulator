import type { ScenarioDefinition } from "./types.js";

export const combinedScenario: ScenarioDefinition = {
  name: "combined",
  title: "Combined suspicious pattern",
  purpose:
    "Produce the strongest final-demo case: the selected player's performance changes and a " +
    "large odds movement follows shortly after, in the same match and time window.",
  expected_downstream_result: "Higher combined score, one case, one Slack alert, and human review.",
  performanceAnomaly: true,
  oddsAnomaly: true,
  defaults: { anomaly_start_second: 60, odds_anomaly_start_second: 90, anomaly_direction: "over" },
};
