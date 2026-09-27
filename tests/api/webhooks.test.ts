import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "../../src/app.js";
import { TEST_API_KEY, fakeSender, silentLogger, testConfig, waitFor } from "../helpers/index.js";

const TEAM_KEY = "team-access-key-0123456789";
const admin = { "x-api-key": TEST_API_KEY };
const team = { "x-api-key": TEAM_KEY };
let built: BuiltApp | null = null;

async function setup(env: Record<string, string> = {}) {
  const fake = fakeSender();
  built = await buildApp({
    config: testConfig({ TEAM_ACCESS_KEY: TEAM_KEY, ...env }),
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

const hook = (over: object = {}) => ({
  name: "Team B risk engine",
  url: "https://team-b.example.org/webhook/risk",
  token: "team-b-secret",
  ...over,
});

describe("session", () => {
  it("reports the role for each key", async () => {
    const { app } = await setup();
    expect((await app.inject({ url: "/api/v1/session", headers: admin })).json().role).toBe(
      "admin",
    );
    expect((await app.inject({ url: "/api/v1/session", headers: team })).json()).toMatchObject({
      role: "team",
      can_control_runs: false,
      can_manage_webhooks: true,
    });
    expect((await app.inject("/api/v1/session")).json().role).toBeNull();
    expect(
      (await app.inject({ url: "/api/v1/session", headers: { "x-api-key": "nope" } })).statusCode,
    ).toBe(401);
  });
});

describe("webhook management", () => {
  it("lets a team register, list, update and delete its webhook", async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: team,
      payload: hook(),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const list = (await app.inject({ url: "/api/v1/webhooks", headers: team })).json();
    expect(list.destinations.map((d: { id: string }) => d.id)).toEqual(["default", id]);
    expect(JSON.stringify(list)).not.toContain("team-b-secret");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/webhooks/${id}`,
      headers: team,
      payload: { enabled: false, event_types: ["odds_update"] },
    });
    expect(patched.json()).toMatchObject({ enabled: false, event_types: ["odds_update"] });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/webhooks/${id}`,
      headers: team,
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("requires a key and returns clear validation errors", async () => {
    const { app } = await setup();
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/webhooks", payload: hook() })).statusCode,
    ).toBe(401);
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: team,
      payload: { name: "" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(["name", "url"]),
    );
  });

  it("rejects private addresses in production", async () => {
    const { app } = await setup({ NODE_ENV: "production" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: team,
      payload: hook({ url: "https://10.1.2.3/webhook" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_webhook_url");
  });

  it("does not let the team key control runs", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: team,
      payload: { preset: "demo_normal" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("fan-out delivery", () => {
  it("delivers every event to the primary webhook and each registered webhook", async () => {
    const { app, engine, calls } = await setup();
    await app.inject({ method: "POST", url: "/api/v1/webhooks", headers: team, payload: hook() });
    await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: team,
      payload: hook({
        name: "Odds desk",
        url: "https://odds.example.org/hook",
        token: "",
        event_types: ["odds_update"],
      }),
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: admin,
      payload: { scenario: "normal", seed: 2, duration_seconds: 30 },
    });
    await waitFor(() => engine.state === "completed" && engine.status().events_pending === 0);

    const s = engine.status();
    const byUrl = (u: string) => calls.filter((c) => c.url === u);
    expect(byUrl("http://n8n.test/webhook/telemetry")).toHaveLength(s.events_generated);
    expect(byUrl("https://team-b.example.org/webhook/risk")).toHaveLength(s.events_generated);
    const oddsCalls = byUrl("https://odds.example.org/hook");
    expect(oddsCalls.length).toBeGreaterThan(0);
    expect(oddsCalls.every((c) => JSON.parse(c.body).event_type === "odds_update")).toBe(true);

    // Each destination gets its own token, never another team's.
    expect(byUrl("https://team-b.example.org/webhook/risk")[0]!.token).toBe("team-b-secret");
    expect(oddsCalls[0]!.token).toBeNull();

    const dests = (await app.inject({ url: "/api/v1/webhooks", headers: team })).json()
      .destinations;
    const teamB = dests.find((d: { name: string }) => d.name === "Team B risk engine");
    expect(teamB.delivery).toMatchObject({
      delivered: s.events_generated,
      failed: 0,
      health: "healthy",
    });
    expect(s.webhook_target.destinations).toBe(3);
  });

  it("lets a production run start with only a dashboard webhook", async () => {
    const { app } = await setup({ NODE_ENV: "production", N8N_WEBHOOK_URL: "" });
    const before = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: admin,
      payload: { preset: "demo_normal" },
    });
    expect(before.statusCode).toBe(503);
    await app.inject({ method: "POST", url: "/api/v1/webhooks", headers: team, payload: hook() });
    expect((await app.inject("/ready")).statusCode).toBe(200);
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: admin,
      payload: { preset: "demo_normal" },
    });
    expect(after.statusCode).toBe(201);
  });

  it("sends a test event to one webhook only", async () => {
    const { app, calls } = await setup();
    const id = (
      await app.inject({ method: "POST", url: "/api/v1/webhooks", headers: team, payload: hook() })
    ).json().id;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/${id}/test`,
      headers: team,
    });
    expect(res.json().delivery).toMatchObject({ ok: true, status: 200 });
    expect(calls.map((c) => c.url)).toEqual(["https://team-b.example.org/webhook/risk"]);
  });
});

describe("dashboard and timeline", () => {
  it("serves the dashboard at / with a strict content security policy", async () => {
    const { app } = await setup();
    const res = await app.inject("/");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await app.inject("/api")).json().dashboard).toBe("/");
  });

  it("returns chart data for the current run", async () => {
    const { app, engine } = await setup();
    await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: admin,
      payload: { scenario: "normal", seed: 4, duration_seconds: 180 },
    });
    await waitFor(() => engine.state === "completed");
    const t = (await app.inject("/api/v1/timeline?player=player_03")).json();
    expect(t.player.player_id).toBe("player_03");
    expect(t.player.samples.length).toBeGreaterThan(3);
    expect(t.odds.length).toBeGreaterThan(3);
    expect(t.rounds.length).toBe(t.match.total_rounds);
    expect(t.snapshots).toHaveLength(10);
  });
});
