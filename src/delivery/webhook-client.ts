import { SERVICE_NAME, SIMULATOR_VERSION } from "../simulator/ids.js";

export interface WebhookTarget {
  /** "default" for N8N_WEBHOOK_URL, the subscription ID for dashboard webhooks. */
  id?: string;
  name?: string;
  /** null means dry-run: events are generated and logged but not sent. */
  url: string | null;
  token: string | null;
}

export type SendCategory = "success" | "http_3xx" | "http_4xx" | "http_5xx" | "timeout" | "network";

export interface SendResult {
  ok: boolean;
  status: number | null;
  category: SendCategory;
  /** Short error description. Never contains the URL or token. */
  error: string | null;
  durationMs: number;
  retryable: boolean;
}

export interface SendMeta {
  eventId: string;
  runId: string;
  attempt: number;
}

export type Sender = (target: WebhookTarget, body: string, meta: SendMeta) => Promise<SendResult>;

const RETRYABLE_STATUS = new Set([408, 425, 429]);

export function createWebhookSender(opts: { timeoutMs: number; fetchImpl?: typeof fetch }): Sender {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (target, body, meta) => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    if (!target.url) {
      return {
        ok: false,
        status: null,
        category: "network",
        error: "no_target",
        durationMs: 0,
        retryable: false,
      };
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": `${SERVICE_NAME}/${SIMULATOR_VERSION}`,
      "x-simulator-event-id": meta.eventId,
      "x-simulator-run-id": meta.runId,
      "x-simulator-attempt": String(meta.attempt),
    };
    if (target.token) headers["x-simulator-token"] = target.token;

    try {
      const res = await doFetch(target.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      // Drain the body so the connection can be reused.
      await res.arrayBuffer().catch(() => undefined);
      const status = res.status;
      if (status >= 200 && status < 300) {
        return {
          ok: true,
          status,
          category: "success",
          error: null,
          durationMs: elapsed(),
          retryable: false,
        };
      }
      const category: SendCategory =
        status >= 500 ? "http_5xx" : status >= 400 ? "http_4xx" : "http_3xx";
      return {
        ok: false,
        status,
        category,
        error: `HTTP ${status}`,
        durationMs: elapsed(),
        retryable: status >= 500 || RETRYABLE_STATUS.has(status),
      };
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
      return {
        ok: false,
        status: null,
        category: timedOut ? "timeout" : "network",
        error: timedOut
          ? `timeout after ${opts.timeoutMs}ms`
          : (e.cause?.code ?? e.name ?? "network_error"),
        durationMs: elapsed(),
        retryable: true,
      };
    }
  };
}

/** Host only, for status output. Paths can contain webhook secrets, so they are never shown. */
export function describeTarget(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}
