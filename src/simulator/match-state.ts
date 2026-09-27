import type {
  ActionMetrics,
  EventScenarioLabel,
  EventType,
  MatchPlayerSummary,
  OddsData,
  OddsReason,
  PlayerSummary,
  Score,
  SimulatorEvent,
} from "../contracts/events.js";
import { SCHEMA_VERSION } from "../contracts/events.js";
import type { AnomalyDirection, OddsAnomalyDirection, RunConfig } from "../contracts/validation.js";
import { PLAYERS, getPlayer, playersOnTeam, type PlayerProfile } from "../data/players.js";
import {
  EVENT_SOURCE,
  MAP_NAME,
  TEAMS,
  TOURNAMENT_ID,
  opponentOf,
  type TeamId,
} from "../data/teams.js";
import { resolveFight } from "../generators/combat.js";
import { OddsModel } from "../generators/odds.js";
import {
  averageMetrics,
  createForm,
  driftForm,
  sampleActionMetrics,
  type MetricForm,
} from "../generators/telemetry.js";
import { ANOMALY_PROFILES, type AnomalyProfile } from "../scenarios/performance-anomaly.js";
import { SIMULATOR_VERSION, eventIdFor, tokenFromRunId } from "./ids.js";
import { Random, deriveSeed, round } from "./random.js";

/** Seconds of match clock between routine odds updates. */
const MARKET_INTERVAL_SECONDS = 10;
/** Rolling window used by player snapshots. */
const SNAPSHOT_WINDOW_SECONDS = 30;
/** The odds shock is kept at least this far from a round boundary so it stays unexplained. */
const ODDS_SHOCK_BOUNDARY_GAP_SECONDS = 3;
const FIGHT_STRENGTH_FACTOR = 0.25;

const ACTION_TYPES = ["aim", "peek", "move", "reload", "ability", "utility"] as const;
const FILLER_TYPES = ["player_action", "combat_event", "player_snapshot"] as const;
const FILLER_WEIGHTS = [0.55, 0.3, 0.15];

interface StatLine {
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
}

interface PlayerState {
  profile: PlayerProfile;
  form: MetricForm;
  window: { t: number; metrics: ActionMetrics }[];
  match: StatLine;
  round: StatLine;
  totals: { reaction: number; accuracy: number; headshot: number; apm: number; count: number };
}

export interface ScenarioTruth {
  performance: {
    player_id: string;
    team_id: TeamId;
    direction: AnomalyDirection;
    start_second: number;
    end_second: number | null;
    first_sequence_number: number | null;
  } | null;
  odds: {
    team_id: TeamId;
    direction: OddsAnomalyDirection;
    scheduled_second: number;
    fired_at_second: number | null;
    movement_pct: number | null;
    event_id: string | null;
    sequence_number: number | null;
  } | null;
}

export interface MatchProgress {
  match_clock_seconds: number;
  duration_seconds: number;
  round_number: number;
  total_rounds: number;
  score: Score;
  finished: boolean;
}

export interface MatchContext {
  runId: string;
  matchId?: string | null;
  config: RunConfig;
  now?: () => Date;
  scenarioLabel?: EventScenarioLabel;
}

type Thunk = () => SimulatorEvent;
type EventOf<T extends EventType> = Extract<SimulatorEvent, { event_type: T }>;

const emptyStats = (): StatLine => ({ kills: 0, deaths: 0, assists: 0, damage: 0 });

/**
 * Deterministic match simulation. Each call to `nextTick` advances the match clock by
 * 1 / event_rate_per_second and returns the events for that tick (normally one).
 * Event content depends only on the run configuration and seed; IDs and wall-clock
 * timestamps are the only values that differ between replays.
 */
export class MatchSimulator {
  readonly runId: string;
  readonly matchId: string;
  readonly config: RunConfig;
  readonly totalRounds: number;
  readonly roundLength: number;

  private readonly rng: Random;
  private readonly now: () => Date;
  private readonly scenarioLabel: EventScenarioLabel;
  private readonly players: Map<string, PlayerState>;
  private readonly odds: OddsModel;
  private readonly anomalyProfile: AnomalyProfile | null;
  private readonly target: PlayerProfile;
  private readonly truthState: ScenarioTruth;

  private tick = 0;
  private sequence = 0;
  private clock = 0;
  private started = false;
  private matchEnding = false;
  private finishedFlag = false;
  private roundNumber = 1;
  private roundKills: Record<TeamId, number> = { team_blue: 0, team_red: 0 };
  private score: Score = { team_blue: 0, team_red: 0 };
  private nextMarketSecond = MARKET_INTERVAL_SECONDS;
  private oddsShockQueued = false;
  private snapshotCursor = 0;
  private pending: Thunk[] = [];

  constructor(ctx: MatchContext) {
    this.config = ctx.config;
    this.runId = ctx.runId;
    this.matchId = ctx.matchId ?? `match_${tokenFromRunId(ctx.runId)}`;
    this.now = ctx.now ?? (() => new Date());
    this.scenarioLabel = ctx.scenarioLabel ?? ctx.config.scenario;
    this.rng = new Random(ctx.config.seed);
    this.odds = new OddsModel(new Random(deriveSeed(ctx.config.seed, 1)), TEAMS[0]!.strength);
    this.totalRounds = Math.max(
      1,
      Math.round(ctx.config.duration_seconds / ctx.config.round_duration_seconds),
    );
    this.roundLength = ctx.config.duration_seconds / this.totalRounds;
    this.players = new Map(
      PLAYERS.map((p) => [
        p.player_id,
        {
          profile: p,
          form: createForm(),
          window: [],
          match: emptyStats(),
          round: emptyStats(),
          totals: { reaction: 0, accuracy: 0, headshot: 0, apm: 0, count: 0 },
        },
      ]),
    );
    this.target = getPlayer(ctx.config.target_player_id);
    this.anomalyProfile = ctx.config.performance_anomaly_enabled
      ? ANOMALY_PROFILES[ctx.config.anomaly_direction]
      : null;

    const c = ctx.config;
    this.truthState = {
      performance: c.performance_anomaly_enabled
        ? {
            player_id: this.target.player_id,
            team_id: this.target.team_id,
            direction: c.anomaly_direction,
            start_second: c.anomaly_start_second,
            end_second:
              c.anomaly_duration_seconds === null
                ? null
                : c.anomaly_start_second + c.anomaly_duration_seconds,
            first_sequence_number: null,
          }
        : null,
      odds: c.odds_anomaly_enabled
        ? {
            team_id: this.target.team_id,
            direction: c.odds_anomaly_direction,
            scheduled_second: c.odds_anomaly_start_second,
            fired_at_second: null,
            movement_pct: null,
            event_id: null,
            sequence_number: null,
          }
        : null,
    };
  }

  get finished(): boolean {
    return this.finishedFlag;
  }

  get eventsCreated(): number {
    return this.sequence;
  }

  /** Internal record of what was injected and when. Never sent downstream. */
  get truth(): ScenarioTruth {
    return structuredClone(this.truthState);
  }

  get progress(): MatchProgress {
    return {
      match_clock_seconds: round(this.clock, 2),
      duration_seconds: this.config.duration_seconds,
      round_number: this.roundNumber,
      total_rounds: this.totalRounds,
      score: { ...this.score },
      finished: this.finishedFlag,
    };
  }

  nextTick(extraFillers = 0): SimulatorEvent[] {
    if (this.finishedFlag) return [];
    const t = this.tick / this.config.event_rate_per_second;
    this.tick++;
    this.clock = t;

    if (!this.started) {
      this.started = true;
      this.pending.push(
        () => this.matchStarted(),
        () => this.oddsUpdate("match_start"),
        () => this.roundStarted(),
      );
    } else if (!this.matchEnding && t >= this.roundNumber * this.roundLength) {
      this.endRound();
    }

    if (this.shouldFireOddsShock(t)) {
      this.oddsShockQueued = true;
      this.pending.push(() => this.oddsShock());
    }
    if (!this.matchEnding && t >= this.nextMarketSecond) {
      this.nextMarketSecond += MARKET_INTERVAL_SECONDS;
      // Skip routine updates that would pile up behind boundary events.
      if (this.pending.length === 0) this.pending.push(() => this.oddsUpdate("market_update"));
    }

    const out: SimulatorEvent[] = [];
    const next = this.pending.shift();
    if (next) {
      out.push(next());
    } else {
      out.push(this.filler(t));
      for (let i = 0; i < extraFillers; i++) out.push(this.filler(t));
    }
    if (this.matchEnding && this.pending.length === 0) this.finishedFlag = true;
    return out;
  }

  /** Builds one standalone event of the given type, used for test events and samples. */
  sampleEvent(type: "player_action" | "combat_event" | "player_snapshot" | "odds_update") {
    this.started = true;
    switch (type) {
      case "player_action":
        return this.playerAction(this.clock);
      case "combat_event":
        return this.combatEvent(this.clock);
      case "player_snapshot":
        return this.playerSnapshot(this.clock);
      case "odds_update":
        return this.oddsUpdate("market_update");
    }
  }

  statusEvent(runState: string, eventsGenerated: number): EventOf<"simulator_status"> {
    return this.build("simulator_status", {
      round_id: this.roundId(),
      player_id: null,
      team_id: null,
      metrics: {},
      odds: {},
      data: { run_state: runState, events_generated: eventsGenerated },
    });
  }

  // ---------------------------------------------------------------------------
  // Scheduling helpers

  private isPerformanceAnomalyActive(t: number): boolean {
    const p = this.truthState.performance;
    if (!p) return false;
    return t >= p.start_second && (p.end_second === null || t < p.end_second);
  }

  private profileFor(player: PlayerProfile, t: number): AnomalyProfile | null {
    return player.player_id === this.target.player_id && this.isPerformanceAnomalyActive(t)
      ? this.anomalyProfile
      : null;
  }

  private shouldFireOddsShock(t: number): boolean {
    const o = this.truthState.odds;
    if (!o || this.oddsShockQueued || this.matchEnding || t < o.scheduled_second) return false;
    if (this.pending.length > 0) return false;
    const sinceBoundary = t - (this.roundNumber - 1) * this.roundLength;
    const untilBoundary = this.roundNumber * this.roundLength - t;
    const nearBoundary =
      (this.roundNumber > 1 && sinceBoundary < ODDS_SHOCK_BOUNDARY_GAP_SECONDS) ||
      (this.roundNumber < this.totalRounds && untilBoundary < ODDS_SHOCK_BOUNDARY_GAP_SECONDS);
    return !nearBoundary;
  }

  private roundId(n = this.roundNumber): string {
    return `round_${String(n).padStart(2, "0")}`;
  }

  private progressRatio(): number {
    return Math.min(1, this.clock / this.config.duration_seconds);
  }

  // ---------------------------------------------------------------------------
  // Event construction

  private build<T extends EventType>(
    event_type: T,
    fields: {
      round_id: string | null;
      player_id: string | null;
      team_id: TeamId | null;
      metrics: object;
      odds: object;
      data: object;
    },
  ): EventOf<T> {
    const sequence = ++this.sequence;
    return {
      event_id: eventIdFor(this.runId, sequence),
      event_type,
      schema_version: SCHEMA_VERSION,
      timestamp: this.now().toISOString(),
      tournament_id: TOURNAMENT_ID,
      match_id: this.matchId,
      round_id: fields.round_id,
      player_id: fields.player_id,
      team_id: fields.team_id,
      sequence_number: sequence,
      scenario: this.scenarioLabel,
      simulator_run_id: this.runId,
      metrics: fields.metrics,
      odds: fields.odds,
      data: fields.data,
      metadata: {
        map: MAP_NAME,
        source: EVENT_SOURCE,
        simulator_version: SIMULATOR_VERSION,
        match_clock_seconds: round(this.clock, 2),
      },
    } as unknown as EventOf<T>;
  }

  private matchStarted(): EventOf<"match_started"> {
    return this.build("match_started", {
      round_id: null,
      player_id: null,
      team_id: null,
      metrics: {},
      odds: {},
      data: {
        teams: TEAMS.map((team) => ({
          team_id: team.team_id,
          name: team.name,
          players: playersOnTeam(team.team_id).map((p) => ({
            player_id: p.player_id,
            display_name: p.display_name,
            role: p.role,
          })),
        })),
        map: MAP_NAME,
        scheduled_duration_seconds: this.config.duration_seconds,
        total_rounds: this.totalRounds,
        round_duration_seconds: round(this.roundLength, 2),
        started_at: this.now().toISOString(),
      },
    });
  }

  private roundStarted(): EventOf<"round_started"> {
    return this.build("round_started", {
      round_id: this.roundId(),
      player_id: null,
      team_id: null,
      metrics: {},
      odds: {},
      data: {
        round_number: this.roundNumber,
        score: { ...this.score },
        active_players: PLAYERS.map((p) => p.player_id),
      },
    });
  }

  private oddsUpdate(reason: OddsReason, roundId = this.roundId()): EventOf<"odds_update"> {
    const odds = this.odds.update(this.score, this.progressRatio(), this.now());
    return this.oddsEvent(odds, reason, roundId);
  }

  private oddsShock(): EventOf<"odds_update"> {
    const o = this.truthState.odds!;
    const odds = this.odds.shock(
      o.team_id,
      o.direction,
      this.config.odds_anomaly_movement_pct,
      this.score,
      this.progressRatio(),
      this.now(),
    );
    // Reason stays market_update: nothing in the match explains this movement.
    const event = this.oddsEvent(odds, "market_update", this.roundId());
    o.fired_at_second = round(this.clock, 2);
    o.movement_pct = odds.movement_pct;
    o.event_id = event.event_id;
    o.sequence_number = event.sequence_number;
    return event;
  }

  private oddsEvent(odds: OddsData, reason: OddsReason, roundId: string): EventOf<"odds_update"> {
    return this.build("odds_update", {
      round_id: roundId,
      player_id: null,
      team_id: null,
      metrics: {},
      odds,
      data: { reason, score: { ...this.score } },
    });
  }

  private filler(t: number): SimulatorEvent {
    const kind = this.rng.weightedPick(FILLER_TYPES, FILLER_WEIGHTS);
    if (kind === "player_action") return this.playerAction(t);
    if (kind === "combat_event") return this.combatEvent(t);
    return this.playerSnapshot(t);
  }

  private sample(state: PlayerState, t: number): ActionMetrics {
    driftForm(this.rng, state.form, state.profile.baseline);
    const profile = this.profileFor(state.profile, t);
    const metrics = sampleActionMetrics(this.rng, state.profile.baseline, state.form, profile);
    state.window.push({ t, metrics });
    while (state.window.length && state.window[0]!.t < t - SNAPSHOT_WINDOW_SECONDS) {
      state.window.shift();
    }
    const tot = state.totals;
    tot.reaction += metrics.reaction_time_ms;
    tot.accuracy += metrics.accuracy_pct;
    tot.headshot += metrics.headshot_pct;
    tot.apm += metrics.actions_per_minute;
    tot.count++;
    return metrics;
  }

  private markAnomalyEvent(player: PlayerProfile, t: number, sequence: number): void {
    const p = this.truthState.performance;
    if (p && p.first_sequence_number === null && this.profileFor(player, t)) {
      p.first_sequence_number = sequence;
    }
  }

  private playerAction(t: number): EventOf<"player_action"> {
    const weights = PLAYERS.map((p) => this.profileFor(p, t)?.activity_weight ?? 1);
    const player = this.rng.weightedPick(PLAYERS, weights);
    const state = this.players.get(player.player_id)!;
    const metrics = this.sample(state, t);
    const event = this.build("player_action", {
      round_id: this.roundId(),
      player_id: player.player_id,
      team_id: player.team_id,
      metrics,
      odds: {},
      data: {
        action_type: this.rng.pick(ACTION_TYPES),
        position: { x: round(this.rng.float(0, 100), 1), y: round(this.rng.float(0, 100), 1) },
      },
    });
    this.markAnomalyEvent(player, t, event.sequence_number);
    return event;
  }

  private combatEvent(t: number): EventOf<"combat_event"> {
    // Team strength mostly shapes the opening odds; its effect on individual fights is small.
    let blueWins = 0.5 + (TEAMS[0]!.strength - 0.5) * FIGHT_STRENGTH_FACTOR;
    const targetProfile = this.profileFor(this.target, t);
    if (targetProfile) {
      blueWins +=
        this.target.team_id === "team_blue"
          ? targetProfile.fight_win_shift
          : -targetProfile.fight_win_shift;
    }
    const attackerTeam: TeamId = this.rng.chance(blueWins) ? "team_blue" : "team_red";
    const attackers = playersOnTeam(attackerTeam);
    const victims = playersOnTeam(opponentOf(attackerTeam));
    const attacker = this.rng.weightedPick(
      attackers,
      attackers.map((p) => this.profileFor(p, t)?.actor_weight ?? 1),
    );
    const victim = this.rng.weightedPick(
      victims,
      victims.map((p) => this.profileFor(p, t)?.victim_weight ?? 1),
    );

    const attackerState = this.players.get(attacker.player_id)!;
    const victimState = this.players.get(victim.player_id)!;
    const metrics = this.sample(attackerState, t);
    const fight = resolveFight(this.rng, attacker, metrics, attackers);

    for (const line of [attackerState.match, attackerState.round]) line.damage += fight.damage;
    if (fight.result === "kill") {
      attackerState.match.kills++;
      attackerState.round.kills++;
      victimState.match.deaths++;
      victimState.round.deaths++;
      this.roundKills[attackerTeam]++;
      if (fight.assist) {
        const assistState = this.players.get(fight.assist.player_id)!;
        assistState.match.assists++;
        assistState.round.assists++;
      }
    }

    const event = this.build("combat_event", {
      round_id: this.roundId(),
      player_id: attacker.player_id,
      team_id: attacker.team_id,
      metrics: { damage: fight.damage, reaction_time_ms: metrics.reaction_time_ms },
      odds: {},
      data: {
        result: fight.result,
        target_player_id: victim.player_id,
        target_team_id: victim.team_id,
        weapon: fight.weapon,
        headshot: fight.headshot,
        assist_player_id: fight.assist?.player_id ?? null,
      },
    });
    this.markAnomalyEvent(attacker, t, event.sequence_number);
    return event;
  }

  private playerSnapshot(t: number): EventOf<"player_snapshot"> {
    const player = PLAYERS[this.snapshotCursor++ % PLAYERS.length]!;
    const state = this.players.get(player.player_id)!;
    const recent = state.window.filter((w) => w.t >= t - SNAPSHOT_WINDOW_SECONDS);
    const avg = averageMetrics(recent.map((w) => w.metrics)) ?? this.sample(state, t);
    const event = this.build("player_snapshot", {
      round_id: this.roundId(),
      player_id: player.player_id,
      team_id: player.team_id,
      metrics: { ...avg, ...state.match },
      odds: {},
      data: {
        window_seconds: SNAPSHOT_WINDOW_SECONDS,
        sample_count: recent.length,
        round_number: this.roundNumber,
      },
    });
    this.markAnomalyEvent(player, t, event.sequence_number);
    return event;
  }

  private roundSummaries(): PlayerSummary[] {
    return PLAYERS.map((p) => ({
      player_id: p.player_id,
      team_id: p.team_id,
      ...this.players.get(p.player_id)!.round,
    }));
  }

  private matchSummaries(): MatchPlayerSummary[] {
    return PLAYERS.map((p) => {
      const s = this.players.get(p.player_id)!;
      const n = s.totals.count;
      const avg = (v: number, d: number) => (n ? round(v / n, d) : null);
      return {
        player_id: p.player_id,
        team_id: p.team_id,
        ...s.match,
        avg_reaction_time_ms: avg(s.totals.reaction, 0),
        avg_accuracy_pct: avg(s.totals.accuracy, 1),
        avg_headshot_pct: avg(s.totals.headshot, 1),
        avg_actions_per_minute: avg(s.totals.apm, 0),
      };
    });
  }

  private endRound(): void {
    const { team_blue: blueKills, team_red: redKills } = this.roundKills;
    const winner: TeamId =
      blueKills > redKills
        ? "team_blue"
        : redKills > blueKills
          ? "team_red"
          : this.rng.chance(0.5)
            ? "team_blue"
            : "team_red";
    this.score[winner]++;

    const endedRound = this.roundNumber;
    const endedRoundId = this.roundId(endedRound);
    const summaries = this.roundSummaries();
    const score = { ...this.score };
    this.pending.push(() =>
      this.build("round_ended", {
        round_id: endedRoundId,
        player_id: null,
        team_id: null,
        metrics: {},
        odds: {},
        data: {
          round_number: endedRound,
          winner_team_id: winner,
          score,
          player_summaries: summaries,
        },
      }),
    );

    for (const state of this.players.values()) state.round = emptyStats();
    this.roundKills = { team_blue: 0, team_red: 0 };

    if (endedRound < this.totalRounds) {
      this.pending.push(() => this.oddsUpdate("round_result", endedRoundId));
      this.roundNumber++;
      this.pending.push(() => this.roundStarted());
    } else {
      this.matchEnding = true;
      this.pending.push(() => this.matchEnded());
    }
  }

  private matchEnded(): EventOf<"match_ended"> {
    const summaries = this.matchSummaries();
    const kills = (team: TeamId) =>
      summaries.filter((s) => s.team_id === team).reduce((sum, s) => sum + s.kills, 0);
    const winner: TeamId =
      this.score.team_blue !== this.score.team_red
        ? this.score.team_blue > this.score.team_red
          ? "team_blue"
          : "team_red"
        : kills("team_red") > kills("team_blue")
          ? "team_red"
          : "team_blue";
    return this.build("match_ended", {
      round_id: null,
      player_id: null,
      team_id: null,
      metrics: {},
      odds: {},
      data: {
        winner_team_id: winner,
        final_score: { ...this.score },
        total_rounds: this.totalRounds,
        duration_seconds: round(this.clock, 2),
        player_summaries: summaries,
      },
    });
  }
}
