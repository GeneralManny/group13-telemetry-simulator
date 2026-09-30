import type { SimulatorEvent } from "../../contracts/events.js";
import {
  evaluateMarket,
  evaluateOddsUpdate,
  evaluatePlayer,
  type OddsSignal,
  type PlayerBaselines,
  type RiskResult,
  type Sample,
  type TeamId,
} from "./risk.js";
import type { Thresholds } from "./thresholds.js";

/**
 * Runs a list of events through the engine in order, keeping the same state the live service
 * keeps (recent samples per player, round event times, unexplained odds moves). Used by tests,
 * threshold tuning and the evidence walkthrough in the team guide.
 */
export class MatchReplay {
  private readonly samples = new Map<string, Sample[]>();
  private readonly roundTimes: number[] = [];
  private readonly oddsSignals: OddsSignal[] = [];
  private readonly pendingOdds: { u: Parameters<typeof evaluateOddsUpdate>[0] }[] = [];

  constructor(
    private readonly baselines: Map<string, PlayerBaselines>,
    private readonly t: Thresholds,
  ) {}

  /** Returns the risk results produced by this event (zero, one, or more). */
  push(e: SimulatorEvent): RiskResult[] {
    const t = e.metadata.match_clock_seconds;
    const out: RiskResult[] = [];

    if (e.event_type === "round_started" || e.event_type === "round_ended") {
      this.roundTimes.push(t);
    }
    // An odds move is judged once the explaining window has passed, so a round event that
    // arrives a moment after the move still counts as explaining it.
    for (let i = this.pendingOdds.length - 1; i >= 0; i--) {
      const { u } = this.pendingOdds[i]!;
      if (t - u.t >= this.t.odds_explained_gap_seconds) {
        this.pendingOdds.splice(i, 1);
        const signal = evaluateOddsUpdate(u, this.roundTimes, this.t);
        if (signal) {
          this.oddsSignals.push(signal);
          out.push(evaluateMarket(signal, this.t));
        }
      }
    }

    if (e.event_type === "odds_update") {
      this.pendingOdds.push({ u: { event_id: e.event_id, t, reason: e.data.reason, ...e.odds } });
    }

    if (e.event_type === "player_action") {
      const list = this.samples.get(e.player_id) ?? [];
      list.push({ event_id: e.event_id, t, ...e.metrics });
      while (list.length && list[0]!.t < t - this.t.window_seconds) list.shift();
      this.samples.set(e.player_id, list);
      out.push(
        evaluatePlayer(
          {
            player_id: e.player_id,
            team_id: e.team_id as TeamId,
            t,
            samples: list,
            baselines: this.baselines.get(e.player_id) ?? null,
            oddsSignals: this.oddsSignals,
          },
          this.t,
        ),
      );
    }
    return out;
  }
}
