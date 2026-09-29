import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CreateSubscriptionSchema,
  SubscriptionError,
  SubscriptionStore,
  checkDestinationUrl,
} from "../../src/delivery/subscriptions.js";
import { silentLogger } from "../helpers/index.js";

const dirs: string[] = [];
function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "sim-webhooks-"));
  dirs.push(dir);
  return join(dir, "nested", "webhooks.json");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function store(filePath: string | null = null, production = true, max = 5) {
  return new SubscriptionStore({
    filePath,
    logger: silentLogger,
    maxSubscriptions: max,
    production,
  });
}
const input = (over: object = {}) =>
  CreateSubscriptionSchema.parse({
    name: "Team A n8n",
    url: "https://team-a.app.n8n.cloud/webhook/abc-123",
    ...over,
  });

describe("webhook store", () => {
  it("creates, lists, updates and removes webhooks without exposing tokens", () => {
    const s = store();
    const created = s.create(input({ token: "secret-token" }));
    expect(created.id).toMatch(/^wh_[0-9a-f]{8}$/);
    expect(created).toMatchObject({ enabled: true, token_set: true, host: "team-a.app.n8n.cloud" });
    expect(JSON.stringify(s.list())).not.toContain("secret-token");
    expect(JSON.stringify(s.list())).not.toContain("abc-123");

    s.update(created.id, { enabled: false });
    expect(s.enabledCount).toBe(0);
    expect(s.targetsFor("player_action")).toEqual([]);

    s.remove(created.id);
    expect(s.count).toBe(0);
  });

  it("persists to disk and reloads after a restart", () => {
    const file = tempFile();
    const first = store(file);
    const created = first.create(input({ token: "tok" }));
    expect(first.persistent).toBe(true);

    const second = store(file);
    expect(second.list().map((w) => w.id)).toEqual([created.id]);
    expect(second.target(created.id)).toMatchObject({ url: input().url, token: "tok" });
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });

  it("filters delivery targets by event type", () => {
    const s = store();
    s.create(input({ name: "Odds only", event_types: ["odds_update"] }));
    s.create(input({ name: "Everything", url: "https://other.example.org/hook" }));
    expect(s.targetsFor("odds_update").map((t) => t.name)).toEqual(["Odds only", "Everything"]);
    expect(s.targetsFor("player_action").map((t) => t.name)).toEqual(["Everything"]);
  });

  it("treats an empty or full event type list as every event", () => {
    expect(input({ event_types: [] }).event_types).toBeNull();
  });

  it("rejects duplicates and enforces the limit", () => {
    const s = store(null, true, 2);
    s.create(input());
    expect(() => s.create(input())).toThrow(SubscriptionError);
    s.create(input({ url: "https://b.example.org/hook" }));
    expect(() => s.create(input({ url: "https://c.example.org/hook" }))).toThrow(/At most 2/);
  });

  it("returns 404 for an unknown id", () => {
    try {
      store().get("wh_nope");
    } catch (err) {
      expect((err as SubscriptionError).statusCode).toBe(404);
      return;
    }
    throw new Error("expected an error");
  });
});

describe("destination URL rules", () => {
  it.each([
    ["https://team.app.n8n.cloud/webhook/x", null],
    ["http://team.example.org/hook", "must use https"],
    ["http://localhost:5678/webhook/7a755220", "points to your own computer"],
    ["https://localhost/hook", "points to your own computer"],
    ["http://127.0.0.1:5678/webhook/x", "points to your own computer"],
    ["https://[::1]/hook", "points to your own computer"],
    ["https://10.0.0.5/hook", "private network address"],
    ["https://192.168.1.2/hook", "private network address"],
    ["https://169.254.169.254/latest", "private network address"],
    ["https://postgres.railway.internal/hook", "private network address"],
    ["https://user:pass@team.example.org/hook", "must not contain a username or password"],
    ["ftp://team.example.org/hook", "must use http or https"],
    ["not a url", "must be a valid URL"],
  ])("production: %s -> %s", (url, expected) => {
    const problem = checkDestinationUrl(url, true);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toContain(expected);
  });

  it("explains how to fix a local n8n address", () => {
    expect(checkDestinationUrl("http://localhost:5678/webhook/x", true)).toContain("tunnel");
  });

  it("allows local http addresses in development", () => {
    expect(checkDestinationUrl("http://localhost:4000/webhook", false)).toBeNull();
  });
});
