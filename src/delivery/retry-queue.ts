import type { Logger } from "pino";
import type { FaultType } from "../contracts/validation.js";
import type { SendResult, Sender, WebhookTarget } from "./webhook-client.js";

export type WebhookHealth = "healthy" | "degraded" | "failing" | "unknown" | "disabled";

export interface DeliveryStats {
  queued: number;
  delivered: number;
  failed: number;
  dropped: number;
  skipped: number;
  cancelled: number;
  retries: number;
  pending: number;
  in_flight: number;
  last_delivery_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
}

/** Delivery results for one destination, across all runs. */
export interface TargetStats {
  attempts: number;
  delivered: number;
  failed: number;
  retries: number;
  last_status_code: number | null;
  last_error: string | null;
  last_attempt_at: string | null;
  last_delivery_at: string | null;
  health: WebhookHealth;
}

export interface FailedDelivery {
  event_id: string;
  event_type: string;
  sequence_number: number;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  failed_at: string;
  fault: FaultType | null;
  target_id: string;
  target_name: string | null;
}

export interface EnqueueInput {
  runId: string;
  target: WebhookTarget;
  payload: unknown;
  eventId: string;
  eventType: string;
  sequence: number;
  fault: FaultType | null;
  delayMs: number;
}

interface QueueItem extends Omit<EnqueueInput, "payload" | "delayMs"> {
  body: string;
  attempts: number;
  notBefore: number;
}

export interface DeliveryQueueOptions {
  sender: Sender;
  logger: Logger;
  maxQueueSize: number;
  maxAttempts: number;
  /** Wait before attempt 2, 3, 4... The last value repeats if attempts exceed the list. */
  retryDelaysMs: number[];
  concurrency: number;
  now?: () => number;
}

const HEALTH_WINDOW = 20;
const FAILING_STREAK = 3;
const MAX_TRACKED_RUNS = 25;
const MAX_RECENT_FAILURES = 20;

const emptyStats = (): DeliveryStats => ({
  queued: 0,
  delivered: 0,
  failed: 0,
  dropped: 0,
  skipped: 0,
  cancelled: 0,
  retries: 0,
  pending: 0,
  in_flight: 0,
  last_delivery_at: null,
  last_status_code: null,
  last_error: null,
});

/**
 * Bounded delivery queue. Events are sent in order with limited concurrency. A failed
 * attempt is rescheduled with backoff without blocking later events. The event body is
 * serialised once, so retries always carry the original event ID.
 */
export class DeliveryQueue {
  private readonly queue: QueueItem[] = [];
  private inFlight = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly runStats = new Map<string, DeliveryStats>();
  private readonly failures = new Map<string, FailedDelivery[]>();
  private readonly outcomes: boolean[] = [];
  private readonly targets = new Map<
    string,
    { stats: Omit<TargetStats, "health">; outcomes: boolean[] }
  >();
  private dropLogCount = 0;
  private idleWaiters: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: DeliveryQueueOptions) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.queue.length + this.inFlight;
  }

  enqueue(input: EnqueueInput): "queued" | "dropped" | "skipped" {
    const stats = this.statsFor(input.runId);
    if (!input.target.url) {
      stats.skipped++;
      this.opts.logger.debug(
        {
          run_id: input.runId,
          event_id: input.eventId,
          event_type: input.eventType,
          sequence_number: input.sequence,
        },
        "dry run: event not delivered (no webhook target)",
      );
      return "skipped";
    }
    if (this.closed || this.size >= this.opts.maxQueueSize) {
      stats.dropped++;
      if (this.dropLogCount++ % 100 === 0) {
        this.opts.logger.warn(
          {
            run_id: input.runId,
            event_id: input.eventId,
            queue_size: this.size,
            dropped_total: this.dropLogCount,
          },
          "delivery queue full: event dropped",
        );
      }
      return "dropped";
    }
    const { payload, delayMs, ...rest } = input;
    this.queue.push({
      ...rest,
      body: JSON.stringify(payload),
      attempts: 0,
      notBefore: this.now() + delayMs,
    });
    stats.queued++;
    stats.pending++;
    this.pump();
    return "queued";
  }

  /** One immediate attempt with no retries. Used by the integration test endpoint. */
  async sendOnce(input: Omit<EnqueueInput, "delayMs">): Promise<SendResult> {
    const stats = this.statsFor(input.runId);
    stats.queued++;
    const item: QueueItem = {
      ...input,
      body: JSON.stringify(input.payload),
      attempts: 0,
      notBefore: 0,
    };
    stats.in_flight++;
    const result = await this.attempt(item);
    stats.in_flight--;
    if (result.ok) {
      stats.delivered++;
      this.targetFor(item).stats.delivered++;
    } else this.recordFailure(item, result);
    return result;
  }

  /** Removes queued (not in-flight) items for a run. Returns the number cancelled. */
  cancelRun(runId: string): number {
    let cancelled = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.runId === runId) {
        this.queue.splice(i, 1);
        cancelled++;
      }
    }
    if (cancelled) {
      const stats = this.statsFor(runId);
      stats.pending -= cancelled;
      stats.cancelled += cancelled;
      this.notifyIfIdle();
    }
    return cancelled;
  }

  stats(runId: string): DeliveryStats {
    return { ...(this.runStats.get(runId) ?? emptyStats()) };
  }

  recentFailures(runId: string, limit = 10): FailedDelivery[] {
    return (this.failures.get(runId) ?? []).slice(-limit).reverse();
  }

  health(): WebhookHealth {
    return healthOf(this.outcomes);
  }

  targetStats(targetId: string): TargetStats {
    const t = this.targets.get(targetId);
    if (!t) {
      return {
        attempts: 0,
        delivered: 0,
        failed: 0,
        retries: 0,
        last_status_code: null,
        last_error: null,
        last_attempt_at: null,
        last_delivery_at: null,
        health: "unknown",
      };
    }
    return { ...t.stats, health: healthOf(t.outcomes) };
  }

  private targetFor(item: QueueItem) {
    const id = item.target.id ?? "default";
    let t = this.targets.get(id);
    if (!t) {
      t = {
        stats: {
          attempts: 0,
          delivered: 0,
          failed: 0,
          retries: 0,
          last_status_code: null,
          last_error: null,
          last_attempt_at: null,
          last_delivery_at: null,
        },
        outcomes: [],
      };
      this.targets.set(id, t);
    }
    return t;
  }

  /** Resolves when nothing is queued or in flight, or after the timeout. */
  async drain(timeoutMs: number): Promise<void> {
    if (this.size === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
      this.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Stops the worker and cancels anything still queued. */
  close(): number {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const runIds = new Set(this.queue.map((q) => q.runId));
    let cancelled = 0;
    for (const runId of runIds) cancelled += this.cancelRun(runId);
    return cancelled;
  }

  private statsFor(runId: string): DeliveryStats {
    let stats = this.runStats.get(runId);
    if (!stats) {
      stats = emptyStats();
      this.runStats.set(runId, stats);
      if (this.runStats.size > MAX_TRACKED_RUNS) {
        const oldest = this.runStats.keys().next().value as string;
        this.runStats.delete(oldest);
        this.failures.delete(oldest);
      }
    }
    return stats;
  }

  private pump(): void {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.now();
    while (this.inFlight < this.opts.concurrency) {
      const index = this.queue.findIndex((q) => q.notBefore <= now);
      if (index < 0) break;
      const [item] = this.queue.splice(index, 1) as [QueueItem];
      this.inFlight++;
      const stats = this.statsFor(item.runId);
      stats.pending--;
      stats.in_flight++;
      void this.process(item).finally(() => {
        this.inFlight--;
        stats.in_flight--;
        this.pump();
        this.notifyIfIdle();
      });
    }
    if (this.queue.length && this.inFlight < this.opts.concurrency) {
      const next = Math.min(...this.queue.map((q) => q.notBefore));
      this.timer = setTimeout(() => this.pump(), Math.max(0, next - now));
      this.timer.unref();
    }
  }

  private async process(item: QueueItem): Promise<void> {
    const result = await this.attempt(item);
    const stats = this.statsFor(item.runId);
    if (result.ok) {
      stats.delivered++;
      this.targetFor(item).stats.delivered++;
      return;
    }
    if (result.retryable && item.attempts < this.opts.maxAttempts && !this.closed) {
      const delays = this.opts.retryDelaysMs;
      const wait = delays[Math.min(item.attempts - 1, delays.length - 1)] ?? 1000;
      item.notBefore = this.now() + wait;
      stats.retries++;
      this.targetFor(item).stats.retries++;
      stats.pending++;
      this.queue.push(item);
      return;
    }
    this.recordFailure(item, result);
  }

  private async attempt(item: QueueItem): Promise<SendResult> {
    item.attempts++;
    const result = await this.opts.sender(item.target, item.body, {
      eventId: item.eventId,
      runId: item.runId,
      attempt: item.attempts,
    });
    const stats = this.statsFor(item.runId);
    stats.last_status_code = result.status;
    stats.last_error = result.error;
    const at = new Date(this.now()).toISOString();
    if (result.ok) stats.last_delivery_at = at;
    this.outcomes.push(result.ok);
    if (this.outcomes.length > HEALTH_WINDOW) this.outcomes.shift();
    const target = this.targetFor(item);
    target.stats.attempts++;
    target.stats.last_status_code = result.status;
    target.stats.last_error = result.error;
    target.stats.last_attempt_at = at;
    if (result.ok) target.stats.last_delivery_at = at;
    target.outcomes.push(result.ok);
    if (target.outcomes.length > HEALTH_WINDOW) target.outcomes.shift();

    const log = {
      run_id: item.runId,
      event_id: item.eventId,
      event_type: item.eventType,
      sequence_number: item.sequence,
      attempt: item.attempts,
      status_code: result.status,
      result: result.category,
      error: result.error,
      duration_ms: result.durationMs,
      fault: item.fault,
      target_id: item.target.id ?? "default",
    };
    if (result.ok) this.opts.logger.info(log, "event delivered");
    else this.opts.logger.warn(log, "event delivery attempt failed");
    return result;
  }

  private recordFailure(item: QueueItem, result: SendResult): void {
    const stats = this.statsFor(item.runId);
    stats.failed++;
    this.targetFor(item).stats.failed++;
    const list = this.failures.get(item.runId) ?? [];
    list.push({
      event_id: item.eventId,
      event_type: item.eventType,
      sequence_number: item.sequence,
      attempts: item.attempts,
      last_status_code: result.status,
      last_error: result.error,
      failed_at: new Date(this.now()).toISOString(),
      fault: item.fault,
      target_id: item.target.id ?? "default",
      target_name: item.target.name ?? null,
    });
    if (list.length > MAX_RECENT_FAILURES) list.shift();
    this.failures.set(item.runId, list);
    this.opts.logger.error(
      {
        run_id: item.runId,
        event_id: item.eventId,
        event_type: item.eventType,
        sequence_number: item.sequence,
        attempts: item.attempts,
        status_code: result.status,
        error: result.error,
        target_id: item.target.id ?? "default",
      },
      "event delivery failed permanently",
    );
  }

  private notifyIfIdle(): void {
    if (this.size !== 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}

function healthOf(outcomes: boolean[]): WebhookHealth {
  if (outcomes.length === 0) return "unknown";
  const tail = outcomes.slice(-FAILING_STREAK);
  if (tail.length === FAILING_STREAK && tail.every((ok) => !ok)) return "failing";
  return outcomes.every((ok) => ok) ? "healthy" : "degraded";
}
