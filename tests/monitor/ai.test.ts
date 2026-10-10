import { describe, expect, it } from "vitest";
import { summarizeCase } from "../../src/monitor/ai.js";
import {
  aiUserMessage,
  directionViolations,
  neutralityViolations,
  type EvidencePacket,
} from "../../src/monitor/evidence.js";
import { silentLogger } from "../helpers/index.js";

const packet: EvidencePacket = {
  case_id: "CASE-TEST01",
  severity: "critical",
  score: 95,
  peak_score: 95,
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
  components: { performance: 55, odds: 30, cluster: 10 },
  rules: [
    {
      rule_id: "PERF_REACTION_TIME",
      component: "performance",
      points: 25,
      description: "Average reaction time was 118 ms, 5.1 standard deviations below baseline.",
      source_event_ids: ["e1"],
    },
  ],
  window: { start: 60, end: 90 },
  metrics_vs_baseline: [],
  odds_moves: [],
  sample_events: [],
  evidence_event_count: 9,
  case_url: null,
};

type Reply = { status: number; body: unknown } | "timeout";

/** A fake OpenRouter that answers each call in turn and records which models were asked. */
function fakeOpenRouter(replies: Reply[]) {
  const asked: string[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    asked.push(JSON.parse(String(init.body)).model);
    const r = replies[i++] ?? { status: 500, body: {} };
    if (r === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

const ok = (content: string, model = "google/gemma-4-31b-it:free") => ({
  status: 200,
  body: { model, choices: [{ message: { content } }] },
});
const config = (models = ["a:free", "b:free", "c:free"]) => ({
  apiKey: "test-key",
  models,
  appUrl: null,
});

describe("AI summary through OpenRouter", () => {
  it("uses the template when no key is configured", async () => {
    const r = await summarizeCase(
      packet,
      { apiKey: null, models: ["a:free"], appUrl: null },
      silentLogger,
    );
    expect(r).toMatchObject({ status: "fallback", reason: "ai_not_configured" });
    expect(r.text).toContain("CASE-TEST01");
  });

  it("returns the first model's grounded summary", async () => {
    const { fetchImpl, asked } = fakeOpenRouter([
      ok("Case CASE-TEST01 is critical. A human should review it."),
    ]);
    const r = await summarizeCase(packet, config(), silentLogger, fetchImpl);
    expect(r).toMatchObject({ status: "generated", model: "google/gemma-4-31b-it:free" });
    expect(asked).toEqual(["a:free"]);
  });

  it("moves to the next free model when one is rate limited or times out", async () => {
    const { fetchImpl, asked } = fakeOpenRouter([
      { status: 429, body: { error: { message: "rate limited" } } },
      "timeout",
      ok("Signals for review only."),
    ]);
    const r = await summarizeCase(packet, config(), silentLogger, fetchImpl);
    expect(r.status).toBe("generated");
    expect(asked).toEqual(["a:free", "b:free", "c:free"]);
  });

  it("removes thinking tags from reasoning models", async () => {
    const { fetchImpl } = fakeOpenRouter([
      ok("<think>working it out</think>\nCase CASE-TEST01 needs review."),
    ]);
    const r = await summarizeCase(packet, config(), silentLogger, fetchImpl);
    expect(r.text).toBe("Case CASE-TEST01 needs review.");
  });

  it("rejects accusing wording and tries the next model, then the template", async () => {
    const { fetchImpl } = fakeOpenRouter([
      ok("player_07 cheated."),
      ok("This is match-fixing."),
      ok("Guilty."),
    ]);
    const r = await summarizeCase(packet, config(), silentLogger, fetchImpl);
    expect(r).toMatchObject({ status: "fallback", reason: "ai_language_check_failed" });
  });

  it("stops at once on a bad key instead of trying every model", async () => {
    const { fetchImpl, asked } = fakeOpenRouter([
      { status: 401, body: { error: { message: "no auth" } } },
    ]);
    const r = await summarizeCase(packet, config(), silentLogger, fetchImpl);
    expect(r).toMatchObject({ status: "fallback", reason: "ai_auth_failed" });
    expect(asked).toHaveLength(1);
  });
});

/** The final demo's case: the odds shortened for Team Blue, player_07's own team, at 1:30. */
const withOdds: EvidencePacket = {
  ...packet,
  rules: [
    ...packet.rules,
    {
      rule_id: "ODDS_UNEXPLAINED_MOVE",
      component: "odds",
      points: 30,
      description:
        "An unexplained 30.1% odds move at 1:30 (shortened for this player's team) occurred 8 seconds from this performance change.",
      source_event_ids: ["odds_90"],
    },
  ],
  odds_moves: [
    {
      event_id: "odds_90",
      match_clock: 90,
      movement_pct: 30.1,
      shortened_team: "team_blue",
      from: { team_blue: 1.9, team_red: 1.9 },
      to: { team_blue: 1.33, team_red: 2.85 },
    },
  ],
};

describe("odds direction in the AI summary", () => {
  it("spells out which team the market moved toward, next to the numbers", () => {
    const sent = JSON.parse(aiUserMessage(withOdds).replace("Evidence packet:\n", ""));
    expect(sent.odds_moves[0]).toMatchObject({
      movement_pct: 30.1,
      match_time: "1:30",
      market_moved_toward: "Team Blue, the player's own team",
      flagged: true,
    });
  });

  it("flags the reversed wording seen in a live alert", () => {
    const live =
      "An unexplained 30.1 % odds move favoring the opposing team occurred at 90 seconds match clock.";
    expect(directionViolations(live, withOdds)).toHaveLength(1);
    expect(directionViolations("The odds moved in favour of Team Red.", withOdds)).toHaveLength(1);
  });

  it("accepts the correct direction, including mentions of the opposing team's odds", () => {
    for (const text of [
      "An unexplained 30.1% odds move at 1:30 shortened for Team Blue, the player's own team.",
      "The market moved toward Team Blue; the opposing team's odds lengthened.",
      "The odds move favoured the player's own team.",
    ]) {
      expect(directionViolations(text, withOdds)).toEqual([]);
    }
  });

  it("checks the mirror case: a Team Red player whose opponents were favoured", () => {
    const red: EvidencePacket = {
      ...withOdds,
      subject: {
        type: "player",
        player_id: "player_03",
        display_name: "Red Three",
        team_id: "team_red",
      },
    };
    expect(directionViolations("The odds move favoured the player's own team.", red)).toHaveLength(
      1,
    );
    expect(
      directionViolations("The odds move favoured Team Blue, the opposing team.", red),
    ).toEqual([]);
  });

  it("skips the check when the case has no flagged odds move", () => {
    expect(directionViolations("Favoring the opposing team.", packet)).toEqual([]);
  });

  it("rejects a reversed summary and uses the next model's correct one", async () => {
    const { fetchImpl, asked } = fakeOpenRouter([
      ok("Case CASE-TEST01: a 30.1% odds move favoring the opposing team. Signals for review."),
      ok(
        "Case CASE-TEST01: a 30.1% odds move toward Team Blue, the player's own team. Signals for review.",
      ),
    ]);
    const r = await summarizeCase(withOdds, config(), silentLogger, fetchImpl);
    expect(r.status).toBe("generated");
    expect(r.text).toContain("toward Team Blue");
    expect(asked).toEqual(["a:free", "b:free"]);
  });

  it("falls back to the template when every model reverses the direction", async () => {
    const wrong = ok("The odds move favoured the opposing team.");
    const { fetchImpl } = fakeOpenRouter([wrong, wrong, wrong]);
    const r = await summarizeCase(withOdds, config(), silentLogger, fetchImpl);
    expect(r).toMatchObject({ status: "fallback", reason: "ai_grounding_check_failed" });
    expect(r.text).toContain("shortened for this player's team");
  });
});

describe("decisions and timing in the AI summary", () => {
  it("gives the model the case window as match time", () => {
    const sent = JSON.parse(aiUserMessage(packet).replace("Evidence packet:\n", ""));
    expect(sent.window_match_time).toBe("1:00 to 1:30 match time");
  });

  it("flags the wording seen in a live summary", () => {
    const live =
      "The performance spikes occurred in the final minutes of the match (around 90-97 seconds). " +
      "These are signals for review only. I recommend approving for investigation by a human administrator.";
    expect(neutralityViolations(live)).toEqual(["recommend approving", "final minutes"]);
  });

  it("flags other ways of favouring one decision", () => {
    for (const text of [
      "The case should be escalated.",
      "We suggest that the case be dismissed.",
      "These signals warrant an investigation.",
      "Recommend escalation to officials.",
    ]) {
      expect(neutralityViolations(text)).toHaveLength(1);
    }
  });

  it("accepts a neutral closing line and the rule wording for the 30-second window", () => {
    for (const text of [
      "A human administrator reviews the case and chooses one of: approve for investigation, dismiss, or escalate.",
      "We recommend that a human administrator review the case and decide whether to approve for investigation, dismiss, or escalate.",
      "Average reaction time was 118 ms across 9 actions in the last 30 seconds, from 0:37 to 1:37 match time.",
    ]) {
      expect(neutralityViolations(text)).toEqual([]);
    }
  });

  it("rejects a steering summary and uses the next model's neutral one", async () => {
    const { fetchImpl, asked } = fakeOpenRouter([
      ok("Case CASE-TEST01 needs review. I recommend escalating it."),
      ok("Case CASE-TEST01: signals for review. A human administrator chooses the outcome."),
    ]);
    const r = await summarizeCase(packet, config(), silentLogger, fetchImpl);
    expect(r.status).toBe("generated");
    expect(r.text).toContain("chooses the outcome");
    expect(asked).toEqual(["a:free", "b:free"]);
  });

  it("falls back to the template when every model favours a decision", async () => {
    const steer = ok("The case should be approved for investigation.");
    const { fetchImpl } = fakeOpenRouter([steer, steer, steer]);
    const r = await summarizeCase(packet, config(), silentLogger, fetchImpl);
    expect(r).toMatchObject({ status: "fallback", reason: "ai_neutrality_check_failed" });
  });
});
