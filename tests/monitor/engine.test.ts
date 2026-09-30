import { describe, expect, it } from "vitest";
import { computeHistoricalBaselines } from "../../src/monitor/engine/baselines.js";
import { MatchReplay } from "../../src/monitor/engine/replay.js";
import {
  alertDecision,
  evaluateOddsUpdate,
  evaluatePlayer,
  type PlayerBaselines,
  type RiskResult,
} from "../../src/monitor/engine/risk.js";
import { DEFAULT_THRESHOLDS as T, severityFor } from "../../src/monitor/engine/thresholds.js";
import {
  fallbackSummary,
  languageViolations,
  type EvidencePacket,
} from "../../src/monitor/evidence.js";
import { simulate } from "../helpers/index.js";

const rows = computeHistoricalBaselines();
const baselines = new Map<string, PlayerBaselines>();
for (const r of rows) {
  const b = baselines.get(r.player_id) ?? ({} as PlayerBaselines);
  b[r.metric] = { mean: r.mean, stddev: r.stddev, sample_size: r.sample_size };
  baselines.set(r.player_id, b);
}

function peaks(body: object) {
  const { events } = simulate(body);
  const replay = new MatchReplay(baselines, T);
  const best = new Map<string, RiskResult>();
  for (const e of events) {
    for (const r of replay.push(e)) {
      const key = r.subject.type === "player" ? r.subject.player_id : "market";
      if (!best.has(key) || r.score > best.get(key)!.score) best.set(key, r);
    }
  }
  return best;
}

describe("baselines", () => {
  it("are learned from 20 simulated historical matches for every player and metric", () => {
    expect(rows).toHaveLength(40);
    const rt = rows.find((r) => r.player_id === "player_07" && r.metric === "reaction_time_ms")!;
    expect(rt.sample_size).toBeGreaterThan(300);
    expect(rt.mean).toBeGreaterThan(215);
    expect(rt.mean).toBeLessThan(245);
  });

  it("are identical every time (repeatable demos)", () => {
    expect(computeHistoricalBaselines()).toEqual(rows);
  });
});

describe("risk engine against the simulator scenarios", () => {
  it("keeps normal play below the monitor threshold (T01)", () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const [, r] of peaks({ scenario: "normal", seed })) {
        expect(r.score).toBeLessThan(T.severity.monitor);
      }
    }
  });

  it("flags fast reactions and an accuracy spike as high, with exact values (T02, T03)", () => {
    const r = peaks({ preset: "performance_demo" }).get("player_07")!;
    expect(r.severity === "high" || r.severity === "critical").toBe(true);
    const rt = r.rules.find((x) => x.rule_id === "PERF_REACTION_TIME")!;
    expect(rt.direction).toBe("below");
    expect(rt.observed).toBeLessThan(160);
    expect(rt.baseline_mean).toBeGreaterThan(200);
    expect(rt.deviation_sd).toBeLessThan(-2.5);
    expect(r.rules.some((x) => x.rule_id === "PERF_ACCURACY" && x.direction === "above")).toBe(
      true,
    );
  });

  it("flags an unexplained odds move on the market, with the time relationship (T05)", () => {
    const m = peaks({ preset: "odds_demo" }).get("market")!;
    expect(m.rules[0]!.rule_id).toBe("ODDS_UNEXPLAINED_MOVE");
    expect(m.rules[0]!.movement_pct).toBeGreaterThanOrEqual(30);
    expect(m.rules[0]!.description).toMatch(/no round result within 5 seconds/);
    expect(m.severity).toBe("monitor");
  });

  it("scores odds plus unusual play higher than either alone, explaining both (T06)", () => {
    const perf = peaks({ preset: "performance_demo" }).get("player_07")!.score;
    const combined = peaks({ preset: "final_demo" }).get("player_07")!;
    expect(combined.severity).toBe("critical");
    expect(combined.score).toBeGreaterThan(perf);
    expect(combined.components.odds).toBeGreaterThan(0);
    expect(combined.components.performance).toBeGreaterThan(0);
    expect(combined.rules.some((r) => r.rule_id === "CLUSTER_MULTI_SIGNAL")).toBe(true);
  });

  it("also explains the underperformance version of the combined pattern", () => {
    const r = peaks({ preset: "final_demo", anomaly_direction: "under" }).get("player_07")!;
    expect(r.score).toBeGreaterThanOrEqual(T.severity.high);
    expect(r.rules.find((x) => x.rule_id === "PERF_REACTION_TIME")!.direction).toBe("above");
  });

  it("does not attach the market signal to players who played normally", () => {
    for (const [key, r] of peaks({ preset: "final_demo" })) {
      if (key !== "player_07" && key !== "market") expect(r.score).toBe(0);
    }
  });
});

describe("risk engine rules", () => {
  const base = baselines.get("player_07")!;
  const sample = (i: number, over: Partial<Record<string, number>> = {}) => ({
    event_id: `e${i}`,
    t: 10 + i,
    reaction_time_ms: base.reaction_time_ms.mean,
    accuracy_pct: base.accuracy_pct.mean,
    headshot_pct: base.headshot_pct.mean,
    actions_per_minute: base.actions_per_minute.mean,
    ...over,
  });

  it("returns insufficient_data when the player has no baseline (T10)", () => {
    const r = evaluatePlayer(
      {
        player_id: "player_99",
        team_id: "team_blue",
        t: 20,
        samples: [sample(1)],
        baselines: null,
        oddsSignals: [],
      },
      T,
    );
    expect(r.status).toBe("insufficient_data");
    expect(r.score).toBe(0);
  });

  it("stays silent below the minimum number of samples (no one-event alarms)", () => {
    const fast = [1, 2, 3].map((i) => sample(i, { reaction_time_ms: 90 }));
    const r = evaluatePlayer(
      {
        player_id: "player_07",
        team_id: "team_blue",
        t: 14,
        samples: fast,
        baselines: base,
        oddsSignals: [],
      },
      T,
    );
    expect(r.score).toBe(0);
    expect(r.note).toMatch(/at least 4/);
  });

  it("treats an odds move next to a round result as explained", () => {
    const u = {
      event_id: "o1",
      t: 50,
      reason: "market_update",
      team_blue: 1.4,
      team_red: 2.9,
      previous_team_blue: 1.9,
      previous_team_red: 1.95,
      movement_pct: 48.7,
    };
    expect(evaluateOddsUpdate(u, [48], T)).toBeNull();
    expect(evaluateOddsUpdate(u, [30], T)).not.toBeNull();
    expect(evaluateOddsUpdate({ ...u, reason: "round_result" }, [], T)).toBeNull();
  });

  it("uses the agreed severity bands at the boundaries", () => {
    expect([29, 30, 59, 60, 79, 80].map((s) => severityFor(s, T))).toEqual([
      "normal",
      "monitor",
      "monitor",
      "high",
      "high",
      "critical",
    ]);
  });

  it("alerts once when a case reaches high, again only when it becomes more severe (T04)", () => {
    expect(alertDecision(null, "monitor", T).needed).toBe(false);
    expect(alertDecision(null, "high", T)).toEqual({ needed: true, reason: "new_case" });
    expect(alertDecision("high", "high", T).needed).toBe(false);
    expect(alertDecision("high", "critical", T)).toEqual({
      needed: true,
      reason: "severity_increase",
    });
    expect(alertDecision("critical", "critical", T).needed).toBe(false);
  });
});

describe("evidence language", () => {
  it("rejects accusatory wording", () => {
    expect(languageViolations("The player cheated in round 3.")).not.toEqual([]);
    expect(languageViolations("This looks like match-fixing.")).not.toEqual([]);
    expect(languageViolations("Reaction time was 5 standard deviations below baseline.")).toEqual(
      [],
    );
    expect(languageViolations("These signals do not prove wrongdoing.")).toEqual([]);
  });

  it("produces a fallback summary that is grounded and non-accusatory (T12)", () => {
    const r = peaks({ preset: "final_demo" }).get("player_07")!;
    const packet: EvidencePacket = {
      case_id: "CASE-TEST01",
      severity: r.severity,
      score: r.score,
      peak_score: r.score,
      status: "open",
      match: {
        match_id: "match_x",
        tournament_id: "tournament_001",
        simulator_run_id: "run_x",
        match_clock_seconds: 120,
        score: { team_blue: 3, team_red: 1 },
      },
      subject: {
        type: "player",
        player_id: "player_07",
        display_name: "Blue Seven",
        team_id: "team_blue",
      },
      components: r.components,
      rules: r.rules,
      window: r.window,
      metrics_vs_baseline: [],
      odds_moves: [],
      sample_events: [],
      evidence_event_count: 10,
      case_url: null,
    };
    const text = fallbackSummary(packet);
    expect(languageViolations(text)).toEqual([]);
    expect(text).toContain("CASE-TEST01");
    expect(text).toContain("PERF_REACTION_TIME");
    expect(text).toMatch(/approve for investigation, dismiss, or escalate/);
  });
});
