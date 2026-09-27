import type { OddsData, Score } from "../contracts/events.js";
import type { TeamId } from "../data/teams.js";
import { clamp, round, type Random } from "../simulator/random.js";

/** Bookmaker margin (overround) applied to fair probabilities. */
export const ODDS_MARGIN = 0.05;
/** Score-driven probability is kept inside this range so normal moves stay moderate. */
const MODEL_P_MIN = 0.3;
const MODEL_P_MAX = 0.7;
/** Absolute bounds once market noise and any injected bias are added. */
const P_MIN = 0.03;
const P_MAX = 0.97;
/** Log-odds shift per round of score difference (grows later in the match). */
const ROUND_WEIGHT = 0.08;
const NOISE_STEP_SD = 0.006;
const NOISE_LIMIT = 0.025;

export interface OddsPair {
  team_blue: number;
  team_red: number;
}

export function oddsFromProbability(pBlue: number): OddsPair {
  return {
    team_blue: Math.max(1.01, round(1 / (pBlue * (1 + ODDS_MARGIN)), 2)),
    team_red: Math.max(1.01, round(1 / ((1 - pBlue) * (1 + ODDS_MARGIN)), 2)),
  };
}

/** Largest absolute percentage change of either team's odds, rounded to 0.1. */
export function movementPct(previous: OddsPair, current: OddsPair): number {
  const blue = Math.abs(current.team_blue - previous.team_blue) / previous.team_blue;
  const red = Math.abs(current.team_red - previous.team_red) / previous.team_red;
  return round(Math.max(blue, red) * 100, 1);
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));

/**
 * Simulated match-winner market. Normal updates follow the score with small noise;
 * `shock` injects a sharp movement with no matching match event and keeps the market
 * at the shifted level afterwards.
 */
export class OddsModel {
  private noise = 0;
  private bias = 0;
  private published: OddsPair | null = null;

  constructor(
    private readonly rng: Random,
    private readonly blueStrength: number,
  ) {}

  private probability(score: Score, progress: number): number {
    const diff = score.team_blue - score.team_red;
    const model = clamp(
      sigmoid(logit(this.blueStrength) + ROUND_WEIGHT * diff * (1 + 0.5 * progress)),
      MODEL_P_MIN,
      MODEL_P_MAX,
    );
    return clamp(model + this.noise + this.bias, P_MIN, P_MAX);
  }

  update(score: Score, progress: number, now: Date): OddsData {
    this.noise = clamp(this.noise + this.rng.normal(0, NOISE_STEP_SD), -NOISE_LIMIT, NOISE_LIMIT);
    return this.publish(oddsFromProbability(this.probability(score, progress)), now);
  }

  /**
   * Moves the market by at least `minMovementPct` toward or against `targetTeam`.
   * Returns the smallest probability shift that reaches the requested movement.
   */
  shock(
    targetTeam: TeamId,
    direction: "toward" | "against",
    minMovementPct: number,
    score: Score,
    progress: number,
    now: Date,
  ): OddsData {
    const p = this.probability(score, progress);
    const previous = this.published ?? oddsFromProbability(p);
    const sign = (targetTeam === "team_blue") === (direction === "toward") ? 1 : -1;
    const maxDelta = sign > 0 ? P_MAX - p : p - P_MIN;
    const moved = (delta: number) =>
      movementPct(previous, oddsFromProbability(p + sign * delta)) >= minMovementPct;

    let delta = maxDelta;
    if (moved(maxDelta)) {
      let lo = 0;
      let hi = maxDelta;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (moved(mid)) hi = mid;
        else lo = mid;
      }
      delta = hi;
    }
    this.bias += sign * delta;
    return this.publish(oddsFromProbability(clamp(p + sign * delta, P_MIN, P_MAX)), now);
  }

  private publish(current: OddsPair, now: Date): OddsData {
    const previous = this.published ?? current;
    this.published = current;
    return {
      provider: "simulator",
      market: "match_winner",
      team_blue: current.team_blue,
      team_red: current.team_red,
      previous_team_blue: previous.team_blue,
      previous_team_red: previous.team_red,
      movement_pct: movementPct(previous, current),
      market_timestamp: now.toISOString(),
    };
  }
}
