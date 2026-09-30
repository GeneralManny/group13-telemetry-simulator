import { resolveRunConfig } from "../../contracts/validation.js";
import { PLAYERS } from "../../data/players.js";
import { MatchSimulator } from "../../simulator/match-state.js";
import { METRICS, type Metric, type MetricBaseline } from "./risk.js";

export const HISTORY_SEEDS = Array.from({ length: 20 }, (_, i) => 5001 + i);
export const HISTORY_SOURCE = `simulated history: ${HISTORY_SEEDS.length} normal matches (seeds ${HISTORY_SEEDS[0]}-${HISTORY_SEEDS.at(-1)})`;

export interface BaselineRow extends MetricBaseline {
  player_id: string;
  metric: Metric;
  min: number;
  max: number;
  source: string;
}

/**
 * Learns each player's baseline from past normal matches. The history is simulated with fixed
 * seeds, so the baselines are identical on every machine and every reset, which keeps demo
 * results repeatable.
 */
export function computeHistoricalBaselines(
  seeds: readonly number[] = HISTORY_SEEDS,
): BaselineRow[] {
  const values = new Map<string, number[]>();
  for (const seed of seeds) {
    const config = resolveRunConfig(
      { scenario: "normal", seed, duration_seconds: 300 },
      { event_rate_per_second: 2, duration_seconds: 300 },
    );
    const sim = new MatchSimulator({ runId: `run_history_${seed}`, config });
    while (!sim.finished) {
      for (const e of sim.nextTick()) {
        if (e.event_type !== "player_action") continue;
        for (const m of METRICS) {
          const key = `${e.player_id}|${m}`;
          const list = values.get(key) ?? [];
          list.push(e.metrics[m]);
          values.set(key, list);
        }
      }
    }
  }

  const rows: BaselineRow[] = [];
  for (const p of PLAYERS) {
    for (const m of METRICS) {
      const list = values.get(`${p.player_id}|${m}`) ?? [];
      if (list.length < 2) continue;
      const mean = list.reduce((s, v) => s + v, 0) / list.length;
      const variance = list.reduce((s, v) => s + (v - mean) ** 2, 0) / (list.length - 1);
      rows.push({
        player_id: p.player_id,
        metric: m,
        sample_size: list.length,
        mean: Math.round(mean * 100) / 100,
        stddev: Math.round(Math.sqrt(variance) * 100) / 100,
        min: Math.min(...list),
        max: Math.max(...list),
        source: HISTORY_SOURCE,
      });
    }
  }
  return rows;
}
