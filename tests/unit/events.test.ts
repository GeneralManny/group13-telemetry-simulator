import { describe, expect, it } from "vitest";
import { REQUIRED_ENVELOPE_FIELDS, SCENARIO_NAMES } from "../../src/contracts/events.js";
import { validateEvent } from "../../src/contracts/validation.js";
import { createRunToken, eventIdFor, runIdFromToken } from "../../src/simulator/ids.js";
import { Random } from "../../src/simulator/random.js";
import { simulate, stripVolatile } from "../helpers/index.js";

describe("seeded random", () => {
  it("produces the same sequence for the same seed", () => {
    const a = new Random(13027);
    const b = new Random(13027);
    const seqA = Array.from({ length: 50 }, () => a.normal(0, 1));
    const seqB = Array.from({ length: 50 }, () => b.normal(0, 1));
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = new Random(1);
    const b = new Random(2);
    expect(Array.from({ length: 5 }, () => a.next())).not.toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
  });
});

describe("event envelope", () => {
  const { events } = simulate({ scenario: "normal", seed: 42, duration_seconds: 120 });

  it("generates unique event IDs within a run", () => {
    const ids = new Set(events.map((e) => e.event_id));
    expect(ids.size).toBe(events.length);
  });

  it("generates event IDs that do not collide across runs", () => {
    const a = runIdFromToken(createRunToken(new Date("2026-09-27T12:00:00Z")));
    const b = runIdFromToken(createRunToken(new Date("2026-09-27T12:00:00Z")));
    expect(a).not.toBe(b);
    expect(eventIdFor(a, 1)).not.toBe(eventIdFor(b, 1));
    expect(a).toMatch(/^run_20260927_120000_[0-9a-f]{4}$/);
  });

  it("increases sequence numbers by one per event", () => {
    events.forEach((e, i) => expect(e.sequence_number).toBe(i + 1));
  });

  it("uses ISO 8601 UTC timestamps", () => {
    for (const e of events) {
      expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(e.timestamp).toISOString()).toBe(e.timestamp);
    }
  });

  it("includes every required envelope field", () => {
    for (const e of events) {
      for (const field of REQUIRED_ENVELOPE_FIELDS) expect(e).toHaveProperty(field);
      expect(e.schema_version).toBe("1.0");
    }
  });

  it("starts with match_started and ends with match_ended", () => {
    expect(events[0]!.event_type).toBe("match_started");
    expect(events.at(-1)!.event_type).toBe("match_ended");
  });

  it.each(SCENARIO_NAMES)("scenario %s emits only contract-valid events", (scenario) => {
    const run = simulate({ scenario, seed: 7, duration_seconds: 180 });
    const invalid = run.events.filter((e) => !validateEvent(e).success);
    expect(invalid).toEqual([]);
  });
});

describe("determinism", () => {
  it("replays the same content for the same seed and configuration", () => {
    const a = simulate({ preset: "final_demo" }, "run_20260927_120000_aaaa");
    const b = simulate({ preset: "final_demo" }, "run_20260927_130000_bbbb");
    expect(a.events.length).toBe(b.events.length);
    expect(a.events.map(stripVolatile)).toEqual(b.events.map(stripVolatile));
    expect(a.sim.truth).toEqual({
      ...b.sim.truth,
      odds: { ...b.sim.truth.odds!, event_id: a.sim.truth.odds!.event_id },
    });
  });

  it("changes content when the seed changes", () => {
    const a = simulate({ scenario: "normal", seed: 1, duration_seconds: 60 });
    const b = simulate({ scenario: "normal", seed: 2, duration_seconds: 60 });
    expect(a.events.map(stripVolatile)).not.toEqual(b.events.map(stripVolatile));
  });
});

describe("match structure", () => {
  const { events, sim } = simulate({ scenario: "normal", seed: 5, duration_seconds: 240 });

  it("plays every round and keeps a consistent score", () => {
    const ended = events.filter((e) => e.event_type === "round_ended");
    expect(ended).toHaveLength(sim.totalRounds);
    const final = events.at(-1)!;
    if (final.event_type !== "match_ended") throw new Error("expected match_ended");
    const { team_blue, team_red } = final.data.final_score;
    expect(team_blue + team_red).toBe(sim.totalRounds);
    if (team_blue > team_red) expect(final.data.winner_team_id).toBe("team_blue");
    if (team_red > team_blue) expect(final.data.winner_team_id).toBe("team_red");
  });

  it("emits two teams of five players", () => {
    const start = events[0]!;
    if (start.event_type !== "match_started") throw new Error("expected match_started");
    expect(start.data.teams).toHaveLength(2);
    for (const team of start.data.teams) expect(team.players).toHaveLength(5);
  });

  it("keeps kill and death totals equal", () => {
    const final = events.at(-1)!;
    if (final.event_type !== "match_ended") throw new Error("expected match_ended");
    const kills = final.data.player_summaries.reduce((s, p) => s + p.kills, 0);
    const deaths = final.data.player_summaries.reduce((s, p) => s + p.deaths, 0);
    expect(kills).toBe(deaths);
    expect(kills).toBe(
      events.filter((e) => e.event_type === "combat_event" && e.data.result === "kill").length,
    );
  });
});
