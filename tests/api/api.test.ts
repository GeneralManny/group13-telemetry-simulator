import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "../../src/app.js";
import { TEST_API_KEY, fakeSender, silentLogger, testConfig, waitFor } from "../helpers/index.js";

let built: BuiltApp | null = null;

async function setup(env: Record<string, string> = {}, respond?: Parameters<typeof fakeSender>[0]) {
  const fake = fakeSender(respond);
  built = await buildApp({
    config: testConfig(env),
    logger: silentLogger,
    sender: fake.sender,
    tickIntervalMs: 2,
  });
  return { ...built, calls: fake.calls };
}

afterEach(async () => {
  if (built) {
    await built.engine.shutdown(100);
    await built.app.close();
    built = null;
  }
});

const auth = { "x-api-key": TEST_API_KEY };

async function post(
  app: BuiltApp["app"],
  url: string,
  payload?: object,
  headers: Record<string, string> = auth,
) {
  return app.inject({ method: "POST", url, headers, ...(payload ? { payload } : {}) });
}

describe("public endpoints", () => {
  it("GET /health returns 200 without a webhook", async () => {
    const { app } = await setup({ N8N_WEBHOOK_URL: "" });
    const res = await app.inject("/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("GET /ready reports missing production variables by name", async () => {
    const { app } = await setup({
      NODE_ENV: "production",
      N8N_WEBHOOK_URL: "",
      CONTROL_API_KEY: "",
    });
    const res = await app.inject("/ready");
    expect(res.statusCode).toBe(503);
    expect(res.json().missing_variables).toEqual(["N8N_WEBHOOK_URL", "CONTROL_API_KEY"]);
  });

  it("GET /ready succeeds with valid configuration", async () => {
    const { app } = await setup();
    const res = await app.inject("/ready");
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ready");
  });

  it("GET /api/v1/status starts idle", async () => {
    const { app } = await setup();
    const res = await app.inject("/api/v1/status");
    expect(res.json()).toMatchObject({
      service: "group13-telemetry-simulator",
      status: "idle",
      run_id: null,
      events_generated: 0,
      schema_version: "1.0",
    });
  });

  it("GET /api/v1/scenarios lists scenarios and presets", async () => {
    const { app } = await setup();
    const body = (await app.inject("/api/v1/scenarios")).json();
    expect(body.scenarios.map((s: { name: string }) => s.name)).toEqual([
      "normal",
      "performance_anomaly",
      "odds_integrity",
      "combined",
      "pipeline_failure",
    ]);
    expect(body.presets.final_demo.seed).toBe(13027);
  });

  it("GET /api/v1/players returns ten stable profiles", async () => {
    const { app } = await setup();
    const body = (await app.inject("/api/v1/players")).json();
    expect(body.players).toHaveLength(10);
    expect(
      body.players.find((p: { player_id: string }) => p.player_id === "player_07"),
    ).toMatchObject({
      display_name: "Blue Seven",
      team_id: "team_blue",
      baseline: { reaction_time_ms: { mean: 230, stddev: 22 } },
    });
  });
});

describe("control API protection", () => {
  it("rejects a missing API key", async () => {
    const { app } = await setup();
    const res = await post(app, "/api/v1/runs", { scenario: "normal" }, {});
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid API key", async () => {
    const { app } = await setup();
    const res = await post(app, "/api/v1/runs", { scenario: "normal" }, { "x-api-key": "wrong" });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a Bearer token", async () => {
    const { app } = await setup();
    const res = await post(
      app,
      "/api/v1/runs",
      { scenario: "normal", duration_seconds: 10 },
      {
        authorization: `Bearer ${TEST_API_KEY}`,
      },
    );
    expect(res.statusCode).toBe(201);
  });

  it("refuses control calls in production when no key is configured", async () => {
    const { app } = await setup({ NODE_ENV: "production", CONTROL_API_KEY: "" });
    const res = await post(app, "/api/v1/runs", { scenario: "normal" }, {});
    expect(res.statusCode).toBe(503);
  });
});

describe("run lifecycle", () => {
  it("starts, pauses, resumes, stops, resets and replays", async () => {
    const { app, engine } = await setup();
    const start = await post(app, "/api/v1/runs", {
      scenario: "normal",
      seed: 1,
      duration_seconds: 600,
    });
    expect(start.statusCode).toBe(201);
    const { run_id: runId, seed } = start.json();
    expect(runId).toMatch(/^run_/);
    expect(seed).toBe(1);

    await waitFor(() => engine.status().events_generated > 5);
    const paused = await post(app, `/api/v1/runs/${runId}/pause`);
    expect(paused.json().status).toBe("paused");
    const countAtPause = engine.status().events_generated;
    const clockAtPause = engine.status().match!.match_clock_seconds;
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.status().events_generated).toBe(countAtPause);

    const resumed = await post(app, "/api/v1/runs/current/resume");
    expect(resumed.json().status).toBe("running");
    await waitFor(() => engine.status().events_generated > countAtPause);
    expect(engine.status().match!.match_clock_seconds).toBeGreaterThan(clockAtPause);

    const stopped = await post(app, `/api/v1/runs/${runId}/stop`);
    expect(stopped.json().status).toBe("stopped");

    const reset = await post(app, `/api/v1/runs/${runId}/reset`);
    expect(reset.json()).toMatchObject({ status: "idle", previous_run_id: runId });
    expect((await app.inject("/api/v1/status")).json().status).toBe("idle");

    const replay = await post(app, `/api/v1/runs/${runId}/replay`);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ status: "running", seed: 1, replay_of: runId });
    expect(replay.json().run_id).not.toBe(runId);
  });

  it("returns a conflict when starting a second active run", async () => {
    const { app } = await setup();
    await post(app, "/api/v1/runs", { scenario: "normal", duration_seconds: 600 });
    const second = await post(app, "/api/v1/runs", { scenario: "normal" });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("run_active");
  });

  it("completes naturally and allows a new start afterwards", async () => {
    const { app, engine } = await setup();
    await post(app, "/api/v1/runs", { scenario: "normal", duration_seconds: 20 });
    await waitFor(() => engine.state === "completed");
    const next = await post(app, "/api/v1/runs", { scenario: "normal", duration_seconds: 20 });
    expect(next.statusCode).toBe(201);
  });

  it("rejects invalid actions for the current state", async () => {
    const { app } = await setup();
    const { run_id } = (
      await post(app, "/api/v1/runs", { scenario: "normal", duration_seconds: 600 })
    ).json();
    const resume = await post(app, `/api/v1/runs/${run_id}/resume`);
    expect(resume.statusCode).toBe(409);
    const unknown = await post(app, "/api/v1/runs/run_nope/pause");
    expect(unknown.statusCode).toBe(404);
  });

  it("returns clear errors for invalid scenarios and parameters", async () => {
    const { app } = await setup();
    const res = await post(app, "/api/v1/runs", { scenario: "cheater", event_rate_per_second: -1 });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("validation_error");
    expect(body.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(["scenario", "event_rate_per_second"]),
    );
  });

  it("accepts an empty JSON body on control calls", async () => {
    const { app } = await setup();
    const { run_id } = (
      await post(app, "/api/v1/runs", { scenario: "normal", duration_seconds: 600 })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${run_id}/pause`,
      headers: { ...auth, "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(200);
  });

  it("exposes the internal scenario truth only to authorised callers", async () => {
    const { app } = await setup();
    await post(app, "/api/v1/runs", { preset: "final_demo" });
    expect((await app.inject("/api/v1/runs/current")).statusCode).toBe(401);
    const res = await app.inject({ url: "/api/v1/runs/current", headers: auth });
    expect(res.json().truth.performance).toMatchObject({
      player_id: "player_07",
      start_second: 60,
    });
  });
});

describe("status counters", () => {
  it("match generated and delivered events", async () => {
    const { app, engine, calls } = await setup();
    await post(app, "/api/v1/runs", { scenario: "normal", seed: 3, duration_seconds: 30 });
    await waitFor(() => engine.state === "completed");
    await waitFor(() => engine.status().events_pending === 0);
    const s = (await app.inject("/api/v1/status")).json();
    expect(s.events_generated).toBeGreaterThan(50);
    expect(s.events_delivered).toBe(s.events_generated);
    expect(s.events_failed).toBe(0);
    expect(calls).toHaveLength(s.events_generated);
    expect(s.webhook_status).toBe("healthy");
    expect(s.match.finished).toBe(true);
  });

  it("show failures and a degraded webhook when n8n rejects events", async () => {
    const { app, engine } = await setup({}, (c) => (c.eventId.endsWith("0") ? 400 : 200));
    await post(app, "/api/v1/runs", { scenario: "normal", seed: 3, duration_seconds: 30 });
    await waitFor(() => engine.state === "completed");
    await waitFor(() => engine.status().events_pending === 0);
    const s = (await app.inject("/api/v1/status")).json();
    expect(s.events_failed).toBeGreaterThan(0);
    expect(s.events_delivered + s.events_failed).toBe(s.events_generated);
    expect(s.recent_delivery_failures[0]).toMatchObject({ last_status_code: 400, attempts: 1 });
  });

  it("does not leak secrets in status", async () => {
    const { app } = await setup();
    await post(app, "/api/v1/runs", { scenario: "normal", duration_seconds: 600 });
    const text = (await app.inject("/api/v1/status")).body;
    expect(text).not.toContain(TEST_API_KEY);
    expect(text).not.toContain("test-webhook-token");
    expect(text).not.toContain("/webhook/telemetry");
  });
});

describe("integration test event", () => {
  it("sends one controlled event and reports the delivery result", async () => {
    const { app, calls } = await setup();
    const res = await post(app, "/api/v1/test-event", { event_type: "odds_update" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.event).toMatchObject({ event_type: "odds_update", scenario: "integration_test" });
    expect(body.delivery).toMatchObject({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.token).toBe("test-webhook-token");
  });

  it("can send a deliberately invalid event", async () => {
    const { app } = await setup();
    const body = (await post(app, "/api/v1/test-event", { fault: "missing_field" })).json();
    expect(body.event).not.toHaveProperty("timestamp");
  });

  it("does not send the shared token to a custom webhook URL", async () => {
    const { app, calls } = await setup();
    await post(app, "/api/v1/test-event", { webhook_url: "https://other.example.org/hook" });
    expect(calls[0]!.token).toBeNull();
  });
});

describe("live preview", () => {
  it("returns the most recent events, newest first", async () => {
    const { app, engine } = await setup();
    await post(app, "/api/v1/runs", { scenario: "normal", duration_seconds: 600 });
    await waitFor(() => engine.status().events_generated >= 10);
    const body = (await app.inject("/api/v1/events/recent?limit=5")).json();
    expect(body.events).toHaveLength(5);
    const seqs = body.events.map(
      (e: { payload: { sequence_number: number } }) => e.payload.sequence_number,
    );
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });
});
