import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SimulatorEvent } from "../../src/contracts/events.js";
import { createPool } from "../../src/monitor/db/database.js";
import { MonitorService, type IngestResult } from "../../src/monitor/service.js";
import { silentLogger, simulate } from "../helpers/index.js";

/**
 * Runs against a real Postgres. Start one with:
 *   docker run -d --name g13-test-pg -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=monitor_test -p 55432:5432 postgres:17-alpine
 *   TEST_DATABASE_URL=postgres://postgres:testpass@localhost:55432/monitor_test npm test
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("monitor service (Postgres)", () => {
  let monitor: MonitorService;

  beforeAll(async () => {
    const pool = createPool(url!);
    await pool.query("DROP SCHEMA IF EXISTS monitor CASCADE");
    monitor = new MonitorService(pool, silentLogger, {
      ai: { apiKey: null, models: [], appUrl: null },
      publicBaseUrl: "https://example.test",
    });
    await monitor.init();
  }, 60_000);

  afterAll(async () => {
    await monitor?.pool.end();
  });

  beforeEach(async () => {
    await monitor.reset("test");
  });

  async function play(
    body: object,
    runId?: string,
  ): Promise<{ events: SimulatorEvent[]; results: IngestResult[] }> {
    const { events } = simulate(body, runId);
    const results: IngestResult[] = [];
    for (const e of events) results.push(await monitor.ingest(e, `trace-${e.sequence_number}`));
    return { events, results };
  }

  const count = async (table: string) =>
    Number(
      (await monitor.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM monitor.${table}`))
        .rows[0]!.n,
    );

  it("stores a normal match once and opens no case (T01)", async () => {
    const { events, results } = await play({ scenario: "normal", seed: 3, duration_seconds: 120 });
    expect(await count("events")).toBe(events.length);
    expect(results.every((r) => r.stored)).toBe(true);
    expect(results.flatMap((r) => r.alerts)).toEqual([]);
    expect(await count("cases")).toBe(0);
    const overview = await monitor.overview();
    expect(overview.match.status).toBe("ended");
  }, 60_000);

  it("stores a duplicate event_id only once (T07)", async () => {
    const { events } = simulate({ scenario: "normal", seed: 1, duration_seconds: 30 });
    const first = await monitor.ingest(events[0]!, null);
    const again = await monitor.ingest(events[0]!, null);
    expect(first.stored).toBe(true);
    expect(again).toMatchObject({ stored: false, duplicate: true });
    expect(await count("events")).toBe(1);
  });

  it("turns the final demo into one critical case with at most two alerts (T04, T06)", async () => {
    const { results } = await play({ preset: "final_demo" });
    const alerts = results.flatMap((r) => r.alerts);
    expect(alerts.map((a) => a.reason)).toEqual(["new_case", "severity_increase"]);
    expect(new Set(alerts.map((a) => a.case_id)).size).toBe(1);

    const cases = await monitor.listCases({});
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      player_id: "player_07",
      severity: "critical",
      status: "open",
    });

    const detail = await monitor.caseDetail(cases[0]!.case_id);
    expect(detail.evidence.rules.map((r) => r.rule_id)).toEqual(
      expect.arrayContaining([
        "PERF_REACTION_TIME",
        "ODDS_UNEXPLAINED_MOVE",
        "CLUSTER_MULTI_SIGNAL",
      ]),
    );
    expect(detail.evidence.odds_moves).toHaveLength(1);
    expect(detail.evidence.evidence_event_count).toBeGreaterThan(5);
    expect(detail.evidence.case_url).toContain(cases[0]!.case_id);
    expect(detail.evidence.metrics_vs_baseline).toHaveLength(4);
  }, 60_000);

  it("keeps scores reproducible: the same replay gives the same case score (T18)", async () => {
    await play({ preset: "final_demo" }, "run_20260930_100000_aaaa");
    const first = (await monitor.listCases({}))[0]!;
    await monitor.reset("test");
    await play({ preset: "final_demo" }, "run_20260930_110000_bbbb");
    const second = (await monitor.listCases({}))[0]!;
    expect(second.peak_score).toBe(first.peak_score);
    expect(second.rule_ids).toEqual(first.rule_ids);
  }, 90_000);

  it("uses the fallback summary without an AI key, then moves the case to pending review (T12)", async () => {
    await play({ preset: "performance_demo", duration_seconds: 160 });
    const [c] = await monitor.listCases({});
    const summary = await monitor.summarize(c!.case_id);
    expect(summary).toMatchObject({
      status: "fallback",
      reason: "ai_not_configured",
      case_status: "pending_review",
    });
    expect(summary.text).toContain(c!.case_id);
  }, 60_000);

  it("records a failed Slack delivery while keeping the case reviewable (T13)", async () => {
    await play({ preset: "performance_demo", duration_seconds: 160 });
    const [c] = await monitor.listCases({});
    await monitor.recordAlert(c!.case_id, { status: "failed", error: "HTTP 500" });
    const d = await monitor.caseDetail(c!.case_id);
    expect(d.case).toMatchObject({
      alert_status: "failed",
      alert_attempts: 1,
      status: "pending_review",
    });
  }, 60_000);

  it("records reviews with reviewer and notes, keeps evidence, and is idempotent (T14-T17)", async () => {
    await play({ preset: "performance_demo", duration_seconds: 160 });
    const [c] = await monitor.listCases({});
    const id = c!.case_id;
    const evidenceBefore = (await monitor.caseDetail(id)).evidence.evidence_event_count;

    const esc = await monitor.review(id, {
      action: "escalate",
      reviewer: "Admin Ada",
      notes: "Needs a second look",
      channel: "dashboard",
    });
    expect(esc).toMatchObject({ status: "escalated", duplicate: false });
    const dup = await monitor.review(id, {
      action: "escalate",
      reviewer: "Admin Ada",
      notes: null,
      channel: "slack",
    });
    expect(dup.duplicate).toBe(true);

    await monitor.review(id, {
      action: "dismiss",
      reviewer: "Admin Ada",
      notes: "Explained by hardware",
      channel: "dashboard",
    });
    await expect(
      monitor.review(id, {
        action: "approve_for_investigation",
        reviewer: "Admin Bo",
        notes: null,
        channel: "dashboard",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const d = await monitor.caseDetail(id);
    expect(d.case).toMatchObject({
      status: "dismissed",
      reviewer: "Admin Ada",
      review_notes: "Explained by hardware",
    });
    expect(d.reviews).toHaveLength(2);
    expect(d.audit.map((a: { to_status: string }) => a.to_status)).toEqual([
      "open",
      "escalated",
      "dismissed",
    ]);
    expect(d.evidence.evidence_event_count).toBe(evidenceBefore);
  }, 60_000);

  it("approves a case for investigation directly from pending review (T14)", async () => {
    await play({ preset: "performance_demo", duration_seconds: 160 });
    const [c] = await monitor.listCases({});
    await monitor.summarize(c!.case_id);
    const r = await monitor.review(c!.case_id, {
      action: "approve_for_investigation",
      reviewer: "Admin Cy",
      notes: "Refer to the integrity officer",
      channel: "dashboard",
    });
    expect(r).toMatchObject({ status: "approved", duplicate: false });
    const d = await monitor.caseDetail(c!.case_id);
    expect(d.case).toMatchObject({ status: "approved", reviewer: "Admin Cy" });
    expect(d.case.reviewed_at).not.toBeNull();
  }, 60_000);

  it("marks an unknown player as insufficient_data instead of inventing a baseline (T10)", async () => {
    const { events } = simulate({ scenario: "normal", seed: 2, duration_seconds: 30 });
    const action = events.find((e) => e.event_type === "player_action")!;
    const r = await monitor.ingest(
      { ...action, event_id: "evt_unknown_player", player_id: "player_99" } as SimulatorEvent,
      null,
    );
    expect(r.results[0]).toMatchObject({ subject: "player_99", status: "insufficient_data" });
  });

  it("stores dead letters and clears run data on reset while keeping baselines", async () => {
    await monitor.addDeadLetter({
      reason: "missing_field",
      error: "timestamp is required",
      payload: { a: 1 },
    });
    expect((await monitor.deadLetters()).length).toBe(1);
    await monitor.reset("test");
    expect(await count("dead_letters")).toBe(0);
    expect(await count("baselines")).toBe(40);
    expect(await count("players")).toBe(10);
  });

  it("lists every player's latest risk for the dashboard", async () => {
    await play({ preset: "final_demo" });
    const p = await monitor.playerRisk();
    expect(p.subjects).toHaveLength(11);
    const seven = p.subjects.find((s) => s.subject === "player_07")!;
    expect(seven.peak_score).toBeGreaterThanOrEqual(80);
    expect(p.subjects.find((s) => s.subject === "player_01")!.peak_score).toBe(0);
  }, 60_000);
});
