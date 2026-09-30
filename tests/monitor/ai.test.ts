import { describe, expect, it } from "vitest";
import { summarizeCase } from "../../src/monitor/ai.js";
import type { EvidencePacket } from "../../src/monitor/evidence.js";
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
