import type { ScenarioName } from "../contracts/events.js";
import { normalScenario } from "./normal.js";
import { performanceAnomalyScenario } from "./performance-anomaly.js";
import { oddsIntegrityScenario } from "./odds-integrity.js";
import { combinedScenario } from "./combined.js";
import { pipelineFailureScenario } from "./pipeline-failure.js";
import type { ScenarioDefinition } from "./types.js";

export type { ScenarioDefinition } from "./types.js";

export const SCENARIOS: Readonly<Record<ScenarioName, ScenarioDefinition>> = {
  normal: normalScenario,
  performance_anomaly: performanceAnomalyScenario,
  odds_integrity: oddsIntegrityScenario,
  combined: combinedScenario,
  pipeline_failure: pipelineFailureScenario,
};

export function getScenario(name: ScenarioName): ScenarioDefinition {
  return SCENARIOS[name];
}
