import { describe, expect, it } from "vitest";
import { DeliveryQueue } from "../../src/delivery/retry-queue.js";
import { createWebhookSender } from "../../src/delivery/webhook-client.js";
import { fakeSender, silentLogger, waitFor } from "../helpers/index.js";

const target = { url: "http://n8n.test/webhook", token: "tok" };

function queue(
  sender: ReturnType<typeof fakeSender>["sender"],
  overrides: Partial<ConstructorParameters<typeof DeliveryQueue>[0]> = {},
) {
  return new DeliveryQueue({
    sender,
    logger: silentLogger,
    maxQueueSize: 100,
    maxAttempts: 4,
    retryDelaysMs: [10, 20, 30],
    concurrency: 2,
    ...overrides,
  });
}

function enqueue(q: DeliveryQueue, n: number, runId = "run_a") {
  for (let i = 1; i <= n; i++) {
    q.enqueue({
      runId,
      target,
      payload: { event_id: `evt_${i}`, sequence_number: i },
      eventId: `evt_${i}`,
      eventType: "player_action",
      sequence: i,
      fault: null,
      delayMs: 0,
    });
  }
}

describe("delivery queue", () => {
  it("records a 2xx response as delivered", async () => {
    const { sender, calls } = fakeSender(() => 202);
    const q = queue(sender);
    enqueue(q, 3);
    await waitFor(() => q.stats("run_a").delivered === 3);
    expect(calls).toHaveLength(3);
    expect(q.stats("run_a")).toMatchObject({ delivered: 3, failed: 0, retries: 0, pending: 0 });
    expect(q.health()).toBe("healthy");
  });

  it("retries temporary failures and keeps the original event ID and body", async () => {
    const { sender, calls } = fakeSender((_c, i) => (i < 2 ? 503 : 200));
    const q = queue(sender, { concurrency: 1 });
    enqueue(q, 1);
    await waitFor(() => q.stats("run_a").delivered === 1);
    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(new Set(calls.map((c) => c.eventId))).toEqual(new Set(["evt_1"]));
    expect(new Set(calls.map((c) => c.body)).size).toBe(1);
    expect(q.stats("run_a").retries).toBe(2);
  });

  it("gives up after the maximum attempts and records the failure", async () => {
    const { sender, calls } = fakeSender(() => "timeout");
    const q = queue(sender);
    enqueue(q, 1);
    await waitFor(() => q.stats("run_a").failed === 1);
    expect(calls).toHaveLength(4);
    const [failure] = q.recentFailures("run_a");
    expect(failure).toMatchObject({ event_id: "evt_1", attempts: 4, last_error: "timeout" });
  });

  it("does not retry permanent 4xx validation failures", async () => {
    const { sender, calls } = fakeSender(() => 422);
    const q = queue(sender);
    enqueue(q, 1);
    await waitFor(() => q.stats("run_a").failed === 1);
    expect(calls).toHaveLength(1);
    expect(q.stats("run_a").last_status_code).toBe(422);
  });

  it("keeps delivering later events while one event is failing", async () => {
    const { sender, calls } = fakeSender((c) => (c.eventId === "evt_1" ? 500 : 200));
    const q = queue(sender, { concurrency: 1 });
    enqueue(q, 5);
    await waitFor(() => q.stats("run_a").delivered === 4 && q.stats("run_a").failed === 1);
    // evt_2 was sent before evt_1's first retry.
    const order = calls.map((c) => c.eventId);
    expect(order.indexOf("evt_2")).toBeLessThan(order.lastIndexOf("evt_1"));
    expect(q.health()).not.toBe("healthy");
  });

  it("drops events when the queue is full instead of growing without bound", async () => {
    const { sender } = fakeSender(() => 200);
    const q = queue(sender, { maxQueueSize: 10, concurrency: 1 });
    enqueue(q, 25);
    expect(q.size).toBeLessThanOrEqual(10);
    await waitFor(() => q.size === 0);
    const s = q.stats("run_a");
    expect(s.dropped).toBe(15);
    expect(s.delivered).toBe(10);
  });

  it("counts every event exactly once", async () => {
    const { sender } = fakeSender((c) =>
      c.eventId === "evt_3" ? 400 : c.attempt === 1 && c.eventId === "evt_4" ? 500 : 200,
    );
    const q = queue(sender);
    enqueue(q, 8);
    await waitFor(() => q.size === 0);
    const s = q.stats("run_a");
    expect(s.delivered + s.failed + s.pending + s.in_flight + s.cancelled + s.dropped).toBe(8);
  });

  it("skips delivery when there is no target (dry run)", () => {
    const { sender, calls } = fakeSender();
    const q = queue(sender);
    const r = q.enqueue({
      runId: "run_a",
      target: { url: null, token: null },
      payload: {},
      eventId: "e",
      eventType: "x",
      sequence: 1,
      fault: null,
      delayMs: 0,
    });
    expect(r).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(q.stats("run_a").skipped).toBe(1);
  });

  it("cancels queued events for a reset run", async () => {
    const { sender } = fakeSender(() => 200);
    const q = queue(sender, { concurrency: 1 });
    for (let i = 1; i <= 5; i++) {
      q.enqueue({
        runId: "run_a",
        target,
        payload: {},
        eventId: `e${i}`,
        eventType: "x",
        sequence: i,
        fault: null,
        delayMs: 10_000,
      });
    }
    expect(q.cancelRun("run_a")).toBe(5);
    expect(q.size).toBe(0);
    expect(q.stats("run_a").cancelled).toBe(5);
  });

  it("holds delayed events until their delay passes", async () => {
    const { sender, calls } = fakeSender(() => 200);
    const q = queue(sender);
    q.enqueue({
      runId: "run_a",
      target,
      payload: {},
      eventId: "late",
      eventType: "x",
      sequence: 1,
      fault: "delayed",
      delayMs: 80,
    });
    enqueue(q, 1);
    await waitFor(() => q.stats("run_a").delivered === 2);
    expect(calls.map((c) => c.eventId)).toEqual(["evt_1", "late"]);
  });
});

describe("webhook client", () => {
  it("sends JSON with the shared token header and classifies responses", async () => {
    const seen: { headers: Headers; body: string }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push({ headers: new Headers(init.headers), body: String(init.body) });
      return new Response("ok", { status: 503 });
    }) as unknown as typeof fetch;
    const send = createWebhookSender({ timeoutMs: 1000, fetchImpl });
    const r = await send(target, '{"a":1}', { eventId: "evt_1", runId: "run_a", attempt: 1 });
    expect(r).toMatchObject({ ok: false, status: 503, category: "http_5xx", retryable: true });
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(seen[0]!.headers.get("x-simulator-token")).toBe("tok");
    expect(seen[0]!.headers.get("x-simulator-event-id")).toBe("evt_1");
  });

  it("reports network errors without leaking the URL", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const send = createWebhookSender({ timeoutMs: 1000, fetchImpl });
    const r = await send({ url: "http://secret-path.test/abc", token: null }, "{}", {
      eventId: "e",
      runId: "r",
      attempt: 1,
    });
    expect(r).toMatchObject({
      ok: false,
      category: "network",
      error: "ECONNREFUSED",
      retryable: true,
    });
  });
});
