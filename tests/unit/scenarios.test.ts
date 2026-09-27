import { describe, expect, it } from "vitest";
import type { SimulatorEvent } from "../../src/contracts/events.js";
import { BASELINES, METRIC_LIMITS, NORMAL_BAND_STDDEV } from "../../src/data/baselines.js";
import { movementPct, oddsFromProbability } from "../../src/generators/odds.js";
import { simulate } from "../helpers/index.js";

type ActionEvent = Extract<SimulatorEvent, { event_type: "player_action" }>;
type OddsEvent = Extract<SimulatorEvent, { event_type: "odds_update" }>;

const actions = (events: SimulatorEvent[]) =>
  events.filter((e): e is ActionEvent => e.event_type === "player_action");
const oddsUpdates = (events: SimulatorEvent[]) =>
  events.filter((e): e is OddsEvent => e.event_type === "odds_update");
const clock = (e: SimulatorEvent) => e.metadata.match_clock_seconds;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

function withinNormalBand(e: ActionEvent): boolean {
  const b = BASELINES[e.player_id]!;
  return (
    ["reaction_time_ms", "accuracy_pct", "headshot_pct", "actions_per_minute"] as const
  ).every((k) => Math.abs(e.metrics[k] - b[k].mean) <= b[k].stddev * NORMAL_BAND_STDDEV + 1);
}

describe("normal scenario", () => {
  const seeds = [1, 2, 3, 13027, 99];

  it("keeps every metric within hard limits and the baseline band", () => {
    for (const seed of seeds) {
      for (const e of actions(simulate({ scenario: "normal", seed }).events)) {
        for (const [k, limit] of Object.entries(METRIC_LIMITS)) {
          const v = e.metrics[k as keyof typeof METRIC_LIMITS];
          expect(v).toBeGreaterThanOrEqual(limit.min);
          expect(v).toBeLessThanOrEqual(limit.max);
        }
        expect(withinNormalBand(e)).toBe(true);
      }
    }
  });

  it("has no large odds movements", () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const o of oddsUpdates(simulate({ scenario: "normal", seed }).events)) {
        expect(o.odds.movement_pct).toBeLessThan(15);
        if (o.data.reason === "market_update") expect(o.odds.movement_pct).toBeLessThan(8);
      }
    }
  });
});

describe("performance anomaly scenario", () => {
  const { events, sim } = simulate({
    scenario: "performance_anomaly",
    seed: 13027,
    target_player_id: "player_07",
    anomaly_start_second: 90,
    anomaly_duration_seconds: 120,
  });
  const target = actions(events).filter((e) => e.player_id === "player_07");
  const others = actions(events).filter((e) => e.player_id !== "player_07");
  const inWindow = (e: SimulatorEvent) => clock(e) >= 90 && clock(e) < 210;

  it("records the anomaly window internally", () => {
    expect(sim.truth.performance).toMatchObject({
      player_id: "player_07",
      start_second: 90,
      end_second: 210,
    });
    expect(sim.truth.performance!.first_sequence_number).toBeGreaterThan(0);
  });

  it("changes the target player sharply inside the window", () => {
    const during = target.filter(inWindow);
    expect(during.length).toBeGreaterThan(20);
    expect(mean(during.map((e) => e.metrics.reaction_time_ms))).toBeLessThan(230 - 3 * 22);
    expect(mean(during.map((e) => e.metrics.accuracy_pct))).toBeGreaterThan(46 + 3 * 6);
    expect(mean(during.map((e) => e.metrics.headshot_pct))).toBeGreaterThan(29 + 3 * 7);
  });

  it("leaves the target player normal outside the window", () => {
    const outside = target.filter((e) => !inWindow(e));
    expect(outside.length).toBeGreaterThan(5);
    for (const e of outside) expect(withinNormalBand(e)).toBe(true);
  });

  it("never affects other players", () => {
    for (const e of others) expect(withinNormalBand(e)).toBe(true);
  });

  it("supports underperformance", () => {
    const run = simulate({ scenario: "performance_anomaly", seed: 5, anomaly_direction: "under" });
    const during = actions(run.events).filter((e) => e.player_id === "player_07" && clock(e) >= 90);
    expect(mean(during.map((e) => e.metrics.reaction_time_ms))).toBeGreaterThan(230 + 3 * 22);
    expect(mean(during.map((e) => e.metrics.accuracy_pct))).toBeLessThan(46 - 2 * 6);
  });
});

describe("odds integrity scenario", () => {
  it("injects one sharp, unexplained movement at the configured second", () => {
    const { events, sim } = simulate({
      scenario: "odds_integrity",
      seed: 13027,
      odds_anomaly_start_second: 90,
    });
    const shock = oddsUpdates(events).find((o) => o.event_id === sim.truth.odds!.event_id)!;
    expect(shock.odds.movement_pct).toBeGreaterThanOrEqual(30);
    expect(shock.data.reason).toBe("market_update");
    expect(clock(shock)).toBeGreaterThanOrEqual(90);
    expect(clock(shock)).toBeLessThan(96);

    // No round boundary event within 3 seconds either side.
    const boundaries = events.filter(
      (e) => e.event_type === "round_ended" || e.event_type === "round_started",
    );
    for (const b of boundaries) expect(Math.abs(clock(b) - clock(shock))).toBeGreaterThanOrEqual(3);

    const larger = oddsUpdates(events).filter((o) => o.odds.movement_pct >= 30);
    expect(larger).toHaveLength(1);
  });

  it("moves the target team's odds in the configured direction", () => {
    const toward = simulate({
      scenario: "odds_integrity",
      seed: 3,
      odds_anomaly_direction: "toward",
    });
    const against = simulate({
      scenario: "odds_integrity",
      seed: 3,
      odds_anomaly_direction: "against",
    });
    const shockOf = (r: typeof toward) =>
      oddsUpdates(r.events).find((o) => o.event_id === r.sim.truth.odds!.event_id)!.odds;
    const t = shockOf(toward);
    const a = shockOf(against);
    // player_07 is on team_blue: toward shortens blue's odds, against lengthens them.
    expect(t.team_blue).toBeLessThan(t.previous_team_blue);
    expect(a.team_blue).toBeGreaterThan(a.previous_team_blue);
  });

  it("reaches the requested movement across many seeds", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { sim } = simulate({ scenario: "odds_integrity", seed, odds_anomaly_movement_pct: 40 });
      expect(sim.truth.odds!.movement_pct).toBeGreaterThanOrEqual(40);
    }
  });

  it("moves the shock away from a round boundary", () => {
    // With 300 s and 25 s rounds, second 100 is a boundary.
    const { sim } = simulate({
      scenario: "odds_integrity",
      seed: 1,
      odds_anomaly_start_second: 100,
    });
    expect(sim.truth.odds!.fired_at_second).toBeGreaterThanOrEqual(103);
    expect(sim.truth.odds!.fired_at_second).toBeLessThan(110);
  });
});

describe("combined scenario", () => {
  it("places both signals in the same match and time window", () => {
    const { sim } = simulate({ preset: "final_demo" });
    expect(sim.truth.performance!.start_second).toBe(60);
    expect(sim.truth.odds!.fired_at_second).toBe(90);
    expect(sim.truth.odds!.team_id).toBe(sim.truth.performance!.team_id);
  });
});

describe("odds calculations", () => {
  it("calculates movement as the largest percentage change of either team", () => {
    expect(
      movementPct({ team_blue: 2.05, team_red: 1.92 }, { team_blue: 1.85, team_red: 2.1 }),
    ).toBe(9.8);
    expect(movementPct({ team_blue: 2, team_red: 2 }, { team_blue: 2, team_red: 2 })).toBe(0);
  });

  it("applies the margin and never goes below 1.01", () => {
    const even = oddsFromProbability(0.5);
    expect(even.team_blue).toBeCloseTo(1.9, 2);
    expect(oddsFromProbability(0.999).team_blue).toBe(1.01);
  });
});
