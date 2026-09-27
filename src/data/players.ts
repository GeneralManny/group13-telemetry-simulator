import { BASELINES, type PlayerBaseline } from "./baselines.js";
import type { TeamId } from "./teams.js";

export type PlayerRole = "attacker" | "entry" | "support" | "sniper" | "anchor";

export interface PlayerProfile {
  player_id: string;
  display_name: string;
  team_id: TeamId;
  role: PlayerRole;
  baseline: PlayerBaseline;
}

function profile(
  player_id: string,
  display_name: string,
  team_id: TeamId,
  role: PlayerRole,
): PlayerProfile {
  const baseline = BASELINES[player_id];
  if (!baseline) throw new Error(`Missing baseline for ${player_id}`);
  return { player_id, display_name, team_id, role, baseline };
}

export const PLAYERS: readonly PlayerProfile[] = [
  profile("player_01", "Red One", "team_red", "entry"),
  profile("player_02", "Red Two", "team_red", "attacker"),
  profile("player_03", "Red Three", "team_red", "support"),
  profile("player_04", "Red Four", "team_red", "sniper"),
  profile("player_05", "Red Five", "team_red", "anchor"),
  profile("player_06", "Blue Six", "team_blue", "entry"),
  profile("player_07", "Blue Seven", "team_blue", "attacker"),
  profile("player_08", "Blue Eight", "team_blue", "support"),
  profile("player_09", "Blue Nine", "team_blue", "sniper"),
  profile("player_10", "Blue Ten", "team_blue", "anchor"),
];

export const PLAYER_IDS: readonly string[] = PLAYERS.map((p) => p.player_id);

const byId = new Map(PLAYERS.map((p) => [p.player_id, p]));

export function getPlayer(playerId: string): PlayerProfile {
  const player = byId.get(playerId);
  if (!player) throw new Error(`Unknown player ${playerId}`);
  return player;
}

export function playersOnTeam(teamId: TeamId): PlayerProfile[] {
  return PLAYERS.filter((p) => p.team_id === teamId);
}

export const WEAPONS_BY_ROLE: Readonly<Record<PlayerRole, readonly string[]>> = {
  entry: ["phantom_smg", "vandal_rifle", "ability_blast"],
  attacker: ["vandal_rifle", "phantom_smg", "sheriff_pistol"],
  support: ["vandal_rifle", "ability_blast", "sheriff_pistol"],
  sniper: ["operator_sniper", "vandal_rifle", "sheriff_pistol"],
  anchor: ["vandal_rifle", "judge_shotgun", "ability_blast"],
};
