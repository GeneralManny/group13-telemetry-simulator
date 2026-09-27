export type TeamId = "team_blue" | "team_red";

export interface Team {
  team_id: TeamId;
  name: string;
  short_name: string;
  /** Relative strength used to set opening odds. 0.5 means evenly matched. */
  strength: number;
}

export const TEAMS: readonly Team[] = [
  { team_id: "team_blue", name: "Team Blue", short_name: "BLU", strength: 0.52 },
  { team_id: "team_red", name: "Team Red", short_name: "RED", strength: 0.48 },
];

export const TEAM_IDS: readonly TeamId[] = TEAMS.map((t) => t.team_id);

export function opponentOf(teamId: TeamId): TeamId {
  return teamId === "team_blue" ? "team_red" : "team_blue";
}

export const TOURNAMENT_ID = "tournament_001";
export const MAP_NAME = "arena_alpha";
export const EVENT_SOURCE = "group13_simulator";
