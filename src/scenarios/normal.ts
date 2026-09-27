import type { ScenarioDefinition } from "./types.js";

export const normalScenario: ScenarioDefinition = {
  name: "normal",
  title: "Normal match",
  purpose: "Prove that realistic play does not generate a high-risk alert.",
  expected_downstream_result: "Normal or monitor risk only.",
  performanceAnomaly: false,
  oddsAnomaly: false,
  defaults: {},
};
