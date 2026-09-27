import type { ActionMetrics } from "../contracts/events.js";
import { WEAPONS_BY_ROLE, type PlayerProfile } from "../data/players.js";
import { clamp, type Random } from "../simulator/random.js";

export interface FightOutcome {
  result: "damage" | "kill";
  damage: number;
  headshot: boolean;
  weapon: string;
  assist: PlayerProfile | null;
}

/** Chance that an engagement ends in a kill, driven by the attacker's current accuracy. */
export function killProbability(accuracyPct: number): number {
  return clamp(0.2 + accuracyPct / 150, 0.2, 0.85);
}

export function resolveFight(
  rng: Random,
  attacker: PlayerProfile,
  attackerMetrics: ActionMetrics,
  teammates: readonly PlayerProfile[],
): FightOutcome {
  const kill = rng.chance(killProbability(attackerMetrics.accuracy_pct));
  const headshotChance = attackerMetrics.headshot_pct / 100;
  const headshot = rng.chance(kill ? headshotChance : headshotChance / 2);
  const damage = kill ? rng.int(100, 150) : rng.int(15, 85);
  const weapon = rng.pick(WEAPONS_BY_ROLE[attacker.role]);
  const others = teammates.filter((p) => p.player_id !== attacker.player_id);
  const assist = kill && others.length > 0 && rng.chance(0.4) ? rng.pick(others) : null;
  return { result: kill ? "kill" : "damage", damage, headshot, weapon, assist };
}
