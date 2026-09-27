/**
 * Writes sample payloads for each scenario to samples/, for sharing with Teams A-D and
 * as a demo fallback. Output is deterministic for a given seed (except IDs and times).
 *
 *   npm run samples
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SimulatorEvent } from "../src/contracts/events.js";
import { resolveRunConfig } from "../src/contracts/validation.js";
import { PLAYERS } from "../src/data/players.js";
import { FaultInjector } from "../src/scenarios/failure-modes.js";
import { PRESETS, type PresetName } from "../src/scenarios/presets.js";
import { createRunToken, runIdFromToken } from "../src/simulator/ids.js";
import { MatchSimulator } from "../src/simulator/match-state.js";

const outDir = join(import.meta.dirname, "..", "samples");
mkdirSync(outDir, { recursive: true });

function runPreset(preset: PresetName) {
  const config = resolveRunConfig({ preset }, { event_rate_per_second: 2, duration_seconds: 300 });
  const sim = new MatchSimulator({ runId: runIdFromToken(createRunToken()), config });
  const events: SimulatorEvent[] = [];
  while (!sim.finished) events.push(...sim.nextTick());
  return { config, sim, events };
}

const write = (name: string, data: unknown) => {
  writeFileSync(join(outDir, name), JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote samples/${name}`);
};

// One example of every event type, from the normal demo.
const normal = runPreset("demo_normal");
const oneOfEach: Record<string, SimulatorEvent> = {};
for (const e of normal.events) oneOfEach[e.event_type] ??= e;
write("event-types.json", oneOfEach);
write("normal-full-run.json", normal.events);

// Performance anomaly: the target player's actions around the anomaly start.
const perf = runPreset("performance_demo");
const start = perf.sim.truth.performance!.start_second;
write("performance-anomaly-sequence.json", {
  truth: perf.sim.truth,
  note: `player_07 events from ${start - 30}s to ${start + 60}s of match clock`,
  events: perf.events.filter(
    (e) =>
      e.player_id === "player_07" &&
      e.metadata.match_clock_seconds >= start - 30 &&
      e.metadata.match_clock_seconds <= start + 60,
  ),
});

// Odds anomaly: every odds update, with the shock marked by the truth record.
const odds = runPreset("odds_demo");
write("odds-integrity-sequence.json", {
  truth: odds.sim.truth,
  events: odds.events.filter((e) => e.event_type === "odds_update"),
});

// Final demo: the full combined run, for Team C evidence summaries and dashboards.
const combined = runPreset("final_demo");
write("combined-final-demo.json", {
  config: PRESETS.final_demo,
  truth: combined.sim.truth,
  events: combined.events,
});

// Pipeline failure examples: one of each injected fault.
const pipeline = runPreset("pipeline_test");
const injector = new FaultInjector(pipeline.config.failure_modes!, pipeline.config.seed);
const faults: Record<string, unknown> = {};
for (const e of pipeline.events) {
  for (const o of injector.apply(e))
    if (o.fault) faults[o.fault] ??= { delay_ms: o.delayMs, payload: o.payload };
}
write("pipeline-failure-examples.json", faults);

write("player-profiles.json", PLAYERS);
