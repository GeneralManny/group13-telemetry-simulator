import type { ScenarioName } from "../contracts/events.js";
import type { FailureModes, RunConfigValues } from "../contracts/validation.js";

export interface ScenarioDefinition {
  name: ScenarioName;
  title: string;
  purpose: string;
  expected_downstream_result: string;
  /** Whether the selected player's metrics are altered from the anomaly start. */
  performanceAnomaly: boolean;
  /** Whether a sharp, unexplained odds movement is injected. */
  oddsAnomaly: boolean;
  /** Scenario-specific defaults, applied before presets and request values. */
  defaults: Partial<RunConfigValues>;
  /** Failure modes enabled by default. Only the pipeline_failure scenario sets this. */
  defaultFailureModes?: Partial<FailureModes>;
}
