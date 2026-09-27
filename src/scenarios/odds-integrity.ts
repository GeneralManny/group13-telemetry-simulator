import type { ScenarioDefinition } from "./types.js";

export const oddsIntegrityScenario: ScenarioDefinition = {
  name: "odds_integrity",
  title: "Odds integrity anomaly",
  purpose:
    "Trigger match-integrity monitoring: odds move sharply at a known second with no " +
    "corresponding match event (reason stays market_update, no round ends nearby).",
  expected_downstream_result: "High odds-integrity risk or monitor case.",
  performanceAnomaly: false,
  oddsAnomaly: true,
  defaults: { odds_anomaly_start_second: 90 },
};
