import { SEVERITY_RANK, severityFor, type Severity, type Thresholds } from "./thresholds.js";

/**
 * The explainable risk engine. Pure functions only: no database, no clock, no randomness.
 * Given the same inputs they always return the same result, which is what lets a stored risk
 * result be re-derived from its stored evidence and what makes these rules unit-testable.
 *
 * Language rule: descriptions state what was measured and how far it is from the player's own
 * history. They never say a player cheated or a match was fixed.
 */

export const METRICS = [
  "reaction_time_ms",
  "accuracy_pct",
  "headshot_pct",
  "actions_per_minute",
] as const;
export type Metric = (typeof METRICS)[number];

export const RULE_IDS = {
  reaction_time_ms: "PERF_REACTION_TIME",
  accuracy_pct: "PERF_ACCURACY",
  headshot_pct: "PERF_HEADSHOT",
  actions_per_minute: "PERF_ACTIVITY",
  odds: "ODDS_UNEXPLAINED_MOVE",
  cluster: "CLUSTER_MULTI_SIGNAL",
} as const;

const METRIC_LABEL: Record<Metric, { name: string; unit: string; decimals: number }> = {
  reaction_time_ms: { name: "reaction time", unit: " ms", decimals: 0 },
  accuracy_pct: { name: "accuracy", unit: "%", decimals: 1 },
  headshot_pct: { name: "headshot rate", unit: "%", decimals: 1 },
  actions_per_minute: { name: "actions per minute", unit: "", decimals: 0 },
};

export interface MetricBaseline {
  mean: number;
  stddev: number;
  sample_size: number;
}

export type PlayerBaselines = Record<Metric, MetricBaseline>;

export interface Sample {
  event_id: string;
  /** Match clock, seconds. */
  t: number;
  reaction_time_ms: number;
  accuracy_pct: number;
  headshot_pct: number;
  actions_per_minute: number;
}

export type TeamId = "team_blue" | "team_red";

export interface OddsUpdate {
  event_id: string;
  t: number;
  reason: string;
  team_blue: number;
  team_red: number;
  previous_team_blue: number;
  previous_team_red: number;
  movement_pct: number;
}

/** An odds move that no match event explains. Match-level, not tied to a player. */
export interface OddsSignal {
  event_id: string;
  t: number;
  movement_pct: number;
  /** The team whose odds shortened, meaning the market moved toward it. */
  shortened_team: TeamId;
  points: number;
  from: { team_blue: number; team_red: number };
  to: { team_blue: number; team_red: number };
}

export type Component = "performance" | "odds" | "cluster";

export interface RuleHit {
  rule_id: string;
  component: Component;
  points: number;
  description: string;
  metric?: Metric;
  observed?: number;
  baseline_mean?: number;
  baseline_stddev?: number;
  /** Signed distance from the baseline, in baseline standard deviations. */
  deviation_sd?: number;
  direction?: "above" | "below";
  sample_count?: number;
  movement_pct?: number;
  seconds_apart?: number;
  source_event_ids: string[];
}

export interface RiskResult {
  status: "scored" | "insufficient_data";
  subject: { type: "player"; player_id: string; team_id: TeamId } | { type: "market" };
  score: number;
  severity: Severity;
  components: Record<Component, number>;
  rules: RuleHit[];
  source_event_ids: string[];
  window: { start: number; end: number };
  note?: string;
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmt = (m: Metric, v: number) =>
  `${round(v, METRIC_LABEL[m].decimals)}${METRIC_LABEL[m].unit}`;

/** Points scale linearly from zero at 2 sd to the full value at full_points_sd. */
function scaledPoints(absDeviation: number, max: number, t: Thresholds): number {
  if (absDeviation < t.trigger_sd) return 0;
  const frac = clamp((absDeviation - 2) / (t.full_points_sd - 2), 0, 1);
  return Math.round(max * frac);
}

/**
 * Decides whether one odds update is an unexplained move. `roundEventTimes` are the match-clock
 * times of round_started and round_ended events in the same match: a move right next to one of
 * those is explained by the match itself.
 */
export function evaluateOddsUpdate(
  u: OddsUpdate,
  roundEventTimes: number[],
  t: Thresholds,
): OddsSignal | null {
  if (u.reason !== "market_update") return null;
  if (u.movement_pct < t.odds_trigger_pct) return null;
  const explained = roundEventTimes.some(
    (rt) => Math.abs(rt - u.t) <= t.odds_explained_gap_seconds,
  );
  if (explained) return null;
  const frac = clamp(
    (u.movement_pct - t.odds_trigger_pct / 2) / (t.odds_full_pct - t.odds_trigger_pct / 2),
    0,
    1,
  );
  const shortened_team: TeamId =
    u.team_blue / u.previous_team_blue <= u.team_red / u.previous_team_red
      ? "team_blue"
      : "team_red";
  return {
    event_id: u.event_id,
    t: u.t,
    movement_pct: u.movement_pct,
    shortened_team,
    points: Math.round(t.odds_max * frac),
    from: { team_blue: u.previous_team_blue, team_red: u.previous_team_red },
    to: { team_blue: u.team_blue, team_red: u.team_red },
  };
}

function finish(
  subject: RiskResult["subject"],
  rules: RuleHit[],
  window: RiskResult["window"],
  t: Thresholds,
  extraSources: string[] = [],
): RiskResult {
  const components: Record<Component, number> = { performance: 0, odds: 0, cluster: 0 };
  for (const r of rules) components[r.component] += r.points;
  components.performance = Math.min(components.performance, t.performance_max);
  components.odds = Math.min(components.odds, t.odds_max);
  components.cluster = Math.min(components.cluster, t.cluster_points);
  const score = Math.min(100, components.performance + components.odds + components.cluster);
  const source_event_ids = [
    ...new Set([...rules.flatMap((r) => r.source_event_ids), ...extraSources]),
  ];
  return {
    status: "scored",
    subject,
    score,
    severity: severityFor(score, t),
    components,
    rules,
    source_event_ids,
    window,
  };
}

/** Risk for the market as a whole: an unexplained odds move on its own. */
export function evaluateMarket(signal: OddsSignal, t: Thresholds): RiskResult {
  const rule: RuleHit = {
    rule_id: RULE_IDS.odds,
    component: "odds",
    points: signal.points,
    movement_pct: signal.movement_pct,
    description:
      `Match-winner odds moved ${signal.movement_pct}% at ${clockText(signal.t)} ` +
      `(Team Blue ${signal.from.team_blue} to ${signal.to.team_blue}, Team Red ${signal.from.team_red} to ${signal.to.team_red}) ` +
      `with no round result within ${t.odds_explained_gap_seconds} seconds to explain it.`,
    source_event_ids: [signal.event_id],
  };
  return finish({ type: "market" }, [rule], { start: signal.t, end: signal.t }, t);
}

export interface PlayerInput {
  player_id: string;
  team_id: TeamId;
  /** Match clock of the event being evaluated. */
  t: number;
  /** The player's action samples; only those inside the window are used. */
  samples: Sample[];
  baselines: PlayerBaselines | null;
  /** Unexplained odds moves in the same match (any time; the engine filters by distance). */
  oddsSignals: OddsSignal[];
}

/** Risk for one player at match time `t`, from their recent actions and the market. */
export function evaluatePlayer(input: PlayerInput, t: Thresholds): RiskResult {
  const subject = { type: "player" as const, player_id: input.player_id, team_id: input.team_id };
  const window = { start: Math.max(0, input.t - t.window_seconds), end: input.t };

  if (!input.baselines) {
    return {
      status: "insufficient_data",
      subject,
      score: 0,
      severity: "normal",
      components: { performance: 0, odds: 0, cluster: 0 },
      rules: [],
      source_event_ids: [],
      window,
      note: `No baseline exists for ${input.player_id}, so no comparison was made.`,
    };
  }

  const inWindow = input.samples.filter((s) => s.t >= window.start && s.t <= window.end);
  const ids = inWindow.map((s) => s.event_id);
  const rules: RuleHit[] = [];

  if (inWindow.length >= t.min_samples) {
    for (const m of METRICS) {
      const b = input.baselines[m];
      if (!b || b.stddev <= 0) continue;
      const avg = inWindow.reduce((sum, s) => sum + s[m], 0) / inWindow.length;
      const d = (avg - b.mean) / b.stddev;
      const points = scaledPoints(Math.abs(d), t.points[m], t);
      if (points <= 0) continue;
      const dir = d >= 0 ? "above" : "below";
      rules.push({
        rule_id: RULE_IDS[m],
        component: "performance",
        points,
        metric: m,
        observed: round(avg, METRIC_LABEL[m].decimals),
        baseline_mean: round(b.mean, 1),
        baseline_stddev: round(b.stddev, 1),
        deviation_sd: round(d, 2),
        direction: dir,
        sample_count: inWindow.length,
        description:
          `Average ${METRIC_LABEL[m].name} was ${fmt(m, avg)} across ${inWindow.length} actions in the last ` +
          `${t.window_seconds} seconds, ${round(Math.abs(d), 1)} standard deviations ${dir} this player's ` +
          `baseline of ${fmt(m, b.mean)}.`,
        source_event_ids: ids,
      });
    }
  }

  const perfRules = rules.length;

  // Odds only count toward a player's case when that player also shows a performance change
  // close in time; otherwise every player in the match would inherit the market signal.
  if (perfRules > 0) {
    const near = input.oddsSignals
      .filter((s) => Math.abs(s.t - input.t) <= t.correlation_seconds)
      .sort((a, b) => b.points - a.points)[0];
    if (near) {
      const apart = round(Math.abs(near.t - input.t), 0);
      const relation =
        near.shortened_team === input.team_id
          ? "shortened for this player's team"
          : "lengthened for this player's team";
      rules.push({
        rule_id: RULE_IDS.odds,
        component: "odds",
        points: near.points,
        movement_pct: near.movement_pct,
        seconds_apart: apart,
        description:
          `An unexplained ${near.movement_pct}% odds move at ${clockText(near.t)} (${relation}) occurred ` +
          `${apart} seconds from this performance change.`,
        source_event_ids: [near.event_id],
      });
    }
  }

  const signalGroups = perfRules + (rules.some((r) => r.component === "odds") ? 1 : 0);
  if (signalGroups >= 2) {
    rules.push({
      rule_id: RULE_IDS.cluster,
      component: "cluster",
      points: t.cluster_points,
      description: `${signalGroups} independent signals occurred within the same window, which makes a coincidence less likely.`,
      source_event_ids: [],
    });
  }

  const result = finish(subject, rules, window, t);
  if (inWindow.length < t.min_samples) {
    result.note = `Only ${inWindow.length} action(s) in the window; at least ${t.min_samples} are needed to compare with the baseline.`;
  }
  return result;
}

/** A case alerts when it first reaches high severity, and again only if it gets more severe. */
export function alertDecision(
  alreadyAlerted: Severity | null,
  current: Severity,
  t: Thresholds,
): { needed: boolean; reason: "new_case" | "severity_increase" | null } {
  if (SEVERITY_RANK[current] < SEVERITY_RANK[severityFor(t.severity.high, t)]) {
    return { needed: false, reason: null };
  }
  if (!alreadyAlerted) return { needed: true, reason: "new_case" };
  if (SEVERITY_RANK[current] > SEVERITY_RANK[alreadyAlerted]) {
    return { needed: true, reason: "severity_increase" };
  }
  return { needed: false, reason: null };
}

export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
