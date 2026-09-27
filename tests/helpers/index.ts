import { pino } from "pino";
import { loadConfig, type AppConfig } from "../../src/config.js";
import type { SimulatorEvent } from "../../src/contracts/events.js";
import { resolveRunConfig, type RunConfig } from "../../src/contracts/validation.js";
import type { SendResult, Sender } from "../../src/delivery/webhook-client.js";
import { MatchSimulator } from "../../src/simulator/match-state.js";

export const TEST_API_KEY = "test-control-key-0123456789";
export const TEST_WEBHOOK_URL = "http://n8n.test/webhook/telemetry";
export const silentLogger = pino({ level: "silent" });

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    CONTROL_API_KEY: TEST_API_KEY,
    N8N_WEBHOOK_URL: TEST_WEBHOOK_URL,
    N8N_WEBHOOK_TOKEN: "test-webhook-token",
    RETRY_DELAYS_MS: "10,20,30",
    ...env,
  });
}

export function resolve(body: object): RunConfig {
  return resolveRunConfig(body, { event_rate_per_second: 2, duration_seconds: 300 });
}

export function simulate(body: object, runId = "run_20260927_120000_abcd") {
  const config = resolve(body);
  const sim = new MatchSimulator({ runId, config });
  const events: SimulatorEvent[] = [];
  while (!sim.finished) events.push(...sim.nextTick());
  return { config, sim, events };
}

/** Event content with the per-run and wall-clock values removed, for determinism checks. */
export function stripVolatile(e: SimulatorEvent) {
  const clone = structuredClone(e) as Record<string, unknown> & {
    odds: Record<string, unknown>;
    data: Record<string, unknown>;
  };
  delete clone.event_id;
  delete clone.timestamp;
  delete clone.simulator_run_id;
  delete clone.match_id;
  delete clone.odds.market_timestamp;
  delete clone.data.started_at;
  return clone;
}

export async function waitFor(check: () => boolean, timeoutMs = 5000, label = "condition") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface RecordedCall {
  url: string | null;
  token: string | null;
  body: string;
  eventId: string;
  attempt: number;
}

/** Fake webhook: `respond` decides each response. Records every call. */
export function fakeSender(
  respond: (call: RecordedCall, callIndex: number) => number | "timeout" = () => 200,
): { sender: Sender; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const sender: Sender = async (target, body, meta) => {
    const call = {
      url: target.url,
      token: target.token,
      body,
      eventId: meta.eventId,
      attempt: meta.attempt,
    };
    calls.push(call);
    const r = respond(call, calls.length - 1);
    await new Promise((res) => setTimeout(res, 1));
    if (r === "timeout") {
      return {
        ok: false,
        status: null,
        category: "timeout",
        error: "timeout",
        durationMs: 1,
        retryable: true,
      } satisfies SendResult;
    }
    const ok = r >= 200 && r < 300;
    return {
      ok,
      status: r,
      category: ok ? "success" : r >= 500 ? "http_5xx" : "http_4xx",
      error: ok ? null : `HTTP ${r}`,
      durationMs: 1,
      retryable: r >= 500 || r === 429,
    } satisfies SendResult;
  };
  return { sender, calls };
}
