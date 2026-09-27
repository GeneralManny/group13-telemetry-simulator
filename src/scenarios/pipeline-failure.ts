import type { ScenarioDefinition } from "./types.js";

export const pipelineFailureScenario: ScenarioDefinition = {
  name: "pipeline_failure",
  title: "Pipeline failure tests",
  purpose:
    "Test Team A's reliability handling: normal play plus duplicate IDs, missing required " +
    "fields, wrong-type data, delayed events, stale timestamps, and a short burst above the " +
    "normal rate. Never enabled unless this scenario or failure_modes is requested explicitly.",
  expected_downstream_result:
    "Duplicates stored once, invalid events routed to the error path, and the run keeps going.",
  performanceAnomaly: false,
  oddsAnomaly: false,
  defaults: {},
  defaultFailureModes: {
    duplicate: true,
    missing_field: true,
    malformed: true,
    delayed: true,
    stale_timestamp: true,
    burst: true,
  },
};
