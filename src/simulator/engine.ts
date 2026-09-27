import type { Logger } from "pino";
import { SCHEMA_VERSION, type SimulatorEvent } from "../contracts/events.js";
import {
  resolveRunConfig,
  validateEvent,
  type RunConfig,
  type TestEventRequest,
} from "../contracts/validation.js";
import { type AppConfig, usableWebhookUrl } from "../config.js";
import type { DeliveryQueue, FailedDelivery, TargetStats } from "../delivery/retry-queue.js";
import type { SubscriptionStore } from "../delivery/subscriptions.js";
import { displayUrl } from "../delivery/subscriptions.js";
import { describeTarget, type SendResult, type WebhookTarget } from "../delivery/webhook-client.js";
import { getPlayer, PLAYERS } from "../data/players.js";
import type { PlayerBaseline } from "../data/baselines.js";
import {
  FaultInjector,
  applySingleFault,
  passThrough,
  type OutgoingEvent,
} from "../scenarios/failure-modes.js";
import { SERVICE_NAME, SIMULATOR_VERSION, createRunToken, runIdFromToken } from "./ids.js";
import { MatchSimulator, type MatchProgress, type ScenarioTruth } from "./match-state.js";
import { Ticker } from "./scheduler.js";

export type RunState = "idle" | "running" | "paused" | "stopped" | "completed" | "failed";

export class EngineError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RunRecord {
  runId: string;
  config: RunConfig;
  simulator: MatchSimulator;
  faults: FaultInjector | null;
  /** Only set for a run started with an explicit webhook_url. */
  customTarget: WebhookTarget | null;
  targetMode: "configured-default" | "custom" | "none";
  timeline: Timeline;
  ticker: Ticker;
  state: RunState;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  replayOf: string | null;
  eventsGenerated: number;
  eventsInvalid: number;
  lastEventAt: string | null;
}

export interface RunSummary {
  run_id: string;
  status: RunState;
  scenario: string;
  preset: string | null;
  started_at: string;
  seed: number;
  match_id: string;
  replay_of: string | null;
  webhook_mode: RunRecord["targetMode"];
  warnings: string[];
}

interface OddsPoint {
  t: number;
  seq: number;
  team_blue: number;
  team_red: number;
  movement_pct: number;
  reason: string;
}

interface SamplePoint {
  t: number;
  reaction_time_ms: number;
  accuracy_pct: number;
  headshot_pct: number;
  actions_per_minute: number;
}

interface Timeline {
  odds: OddsPoint[];
  rounds: { t: number; round_number: number; winner_team_id: string }[];
  samples: Map<string, SamplePoint[]>;
  snapshots: Map<string, { t: number; metrics: Record<string, number> }>;
}

export interface Destination {
  id: string;
  name: string;
  source: "environment" | "dashboard";
  host: string;
  url_display: string;
  enabled: boolean;
  event_types: string[] | null;
  token_set: boolean;
  created_at: string | null;
  delivery: TargetStats;
}

const TIMELINE_LIMIT = 5000;

export interface EmittedEvent {
  emitted_at: string;
  fault: string | null;
  payload: Record<string, unknown>;
}

export interface EngineOptions {
  config: AppConfig;
  delivery: DeliveryQueue;
  subscriptions: SubscriptionStore;
  logger: Logger;
  /** Overrides the real-time tick interval. Tests use this to run matches quickly. */
  tickIntervalMs?: number;
  now?: () => Date;
}

const RECENT_EVENT_LIMIT = 200;
const ACTIVE_STATES: RunState[] = ["running", "paused"];

/**
 * Owns the single active run and the simulator state machine:
 * idle -> running <-> paused -> stopped | completed | failed -> (reset) idle | (replay) running
 */
export class SimulatorEngine {
  private run: RunRecord | null = null;
  private lastConfig: RunConfig | null = null;
  private lastRunId: string | null = null;
  private readonly recent: EmittedEvent[] = [];
  private readonly listeners = new Set<(e: EmittedEvent) => void>();
  private readonly startedAtMs = Date.now();
  private readonly now: () => Date;

  constructor(private readonly opts: EngineOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  get state(): RunState {
    return this.run?.state ?? "idle";
  }

  // ---------------------------------------------------------------------------
  // Control

  start(config: RunConfig, replayOf: string | null = null): RunSummary {
    if (this.run && ACTIVE_STATES.includes(this.run.state)) {
      throw new EngineError(
        409,
        "run_active",
        `Run ${this.run.runId} is ${this.run.state}. Stop or reset it before starting another.`,
      );
    }
    const { customTarget, mode, warnings } = this.resolveMode(config);
    const startedAt = this.now();
    const runId = runIdFromToken(createRunToken(startedAt));
    const simulator = new MatchSimulator({
      runId,
      matchId: config.match_id,
      config,
      now: this.now,
    });
    const rate = config.event_rate_per_second;
    const record: RunRecord = {
      runId,
      config,
      simulator,
      faults: config.failure_modes ? new FaultInjector(config.failure_modes, config.seed) : null,
      customTarget,
      targetMode: mode,
      timeline: { odds: [], rounds: [], samples: new Map(), snapshots: new Map() },
      ticker: new Ticker(this.opts.tickIntervalMs ?? 1000 / rate, () => this.onTick(record)),
      state: "running",
      startedAt: startedAt.toISOString(),
      endedAt: null,
      error: null,
      replayOf,
      eventsGenerated: 0,
      eventsInvalid: 0,
      lastEventAt: null,
    };
    this.run = record;
    this.lastConfig = config;
    this.lastRunId = runId;
    record.ticker.start();
    this.opts.logger.info(
      {
        run_id: runId,
        scenario: config.scenario,
        preset: config.preset,
        seed: config.seed,
        event_rate_per_second: rate,
        duration_seconds: config.duration_seconds,
        replay_of: replayOf,
        webhook_mode: mode,
        failure_modes: config.failure_modes ? true : false,
      },
      "run started",
    );
    return this.summary(record, warnings);
  }

  pause(runIdParam: string): RunSummary {
    const run = this.requireCurrent(runIdParam);
    if (run.state !== "running") throw this.badState(run, "pause", "running");
    run.ticker.stop();
    run.state = "paused";
    this.emitStatus(run);
    this.opts.logger.info({ run_id: run.runId }, "run paused");
    return this.summary(run);
  }

  resume(runIdParam: string): RunSummary {
    const run = this.requireCurrent(runIdParam);
    if (run.state !== "paused") throw this.badState(run, "resume", "paused");
    run.state = "running";
    this.emitStatus(run);
    run.ticker.start();
    this.opts.logger.info({ run_id: run.runId }, "run resumed");
    return this.summary(run);
  }

  stop(runIdParam: string): RunSummary {
    const run = this.requireCurrent(runIdParam);
    if (!ACTIVE_STATES.includes(run.state)) throw this.badState(run, "stop", "running or paused");
    run.ticker.stop();
    run.state = "stopped";
    run.endedAt = this.now().toISOString();
    this.emitStatus(run);
    this.opts.logger.info(
      { run_id: run.runId, events_generated: run.eventsGenerated },
      "run stopped",
    );
    return this.summary(run);
  }

  /** Clears the run from any state and cancels its queued deliveries. */
  reset(runIdParam: string): {
    status: "idle";
    previous_run_id: string;
    cancelled_deliveries: number;
  } {
    const runId = this.resolveRunId(runIdParam);
    const run = this.run;
    if (run && run.runId === runId) {
      run.ticker.stop();
      this.run = null;
    }
    const cancelled = this.opts.delivery.cancelRun(runId);
    this.opts.logger.info({ run_id: runId, cancelled_deliveries: cancelled }, "run reset");
    return { status: "idle", previous_run_id: runId, cancelled_deliveries: cancelled };
  }

  /** Starts a new run with the same configuration and seed as `runId`. */
  replay(runIdParam: string): RunSummary {
    const runId = this.resolveRunId(runIdParam);
    if (runId !== this.lastRunId || !this.lastConfig) {
      throw new EngineError(
        404,
        "run_not_found",
        `Only the most recent run (${this.lastRunId}) can be replayed.`,
      );
    }
    return this.start(this.lastConfig, runId);
  }

  // ---------------------------------------------------------------------------
  // Integration test event

  /**
   * Sends one event to every current destination (or only `onlyTarget`), one attempt each.
   * `delivery` is the first result, kept for compatibility; `deliveries` has them all.
   */
  async sendTestEvent(
    req: TestEventRequest,
    onlyTarget?: WebhookTarget,
  ): Promise<{
    event: Record<string, unknown>;
    delivery: SendResult | { skipped: true; reason: string };
    deliveries: { destination_id: string; name: string | null; result: SendResult }[];
  }> {
    const token = createRunToken(this.now());
    const runId = `test_${token}`;
    const { customTarget, mode } = this.resolveMode({ webhook_url: req.webhook_url }, true);
    const simulator = new MatchSimulator({
      runId,
      matchId: `match_test_${token}`,
      config: resolveRunConfig(
        { scenario: "normal" },
        { event_rate_per_second: 1, duration_seconds: 60 },
      ),
      now: this.now,
      scenarioLabel: "integration_test",
    });
    const event = simulator.sampleEvent(req.event_type);
    const payload =
      req.fault === "none"
        ? (event as unknown as Record<string, unknown>)
        : applySingleFault(event, req.fault);
    this.record({
      emitted_at: this.now().toISOString(),
      fault: req.fault === "none" ? null : req.fault,
      payload,
    });

    const targets = onlyTarget
      ? [onlyTarget]
      : this.targetsFor(mode, customTarget, event.event_type);
    if (targets.length === 0) {
      this.opts.logger.info(
        { run_id: runId, event_id: event.event_id },
        "test event generated (dry run)",
      );
      return {
        event: payload,
        delivery: { skipped: true, reason: "no webhook destination configured" },
        deliveries: [],
      };
    }
    const deliveries = await Promise.all(
      targets.map(async (target) => ({
        destination_id: target.id ?? "default",
        name: target.name ?? null,
        result: await this.opts.delivery.sendOnce({
          runId,
          target,
          payload,
          eventId: event.event_id,
          eventType: event.event_type,
          sequence: event.sequence_number,
          fault: req.fault === "none" ? null : req.fault,
        }),
      })),
    );
    return { event: payload, delivery: deliveries[0]!.result, deliveries };
  }

  // ---------------------------------------------------------------------------
  // Read models

  status() {
    const run = this.run;
    const runId = run?.runId ?? null;
    const d = runId ? this.opts.delivery.stats(runId) : null;
    const defaultUrl = usableWebhookUrl(this.opts.config);
    const mode = run?.targetMode ?? "configured-default";
    const activeDestinations =
      mode === "none"
        ? 0
        : mode === "custom"
          ? 1
          : (defaultUrl ? 1 : 0) + this.opts.subscriptions.enabledCount;
    return {
      service: SERVICE_NAME,
      version: SIMULATOR_VERSION,
      schema_version: SCHEMA_VERSION,
      status: this.state,
      run_id: runId,
      last_run_id: this.lastRunId,
      scenario: run?.config.scenario ?? null,
      preset: run?.config.preset ?? null,
      seed: run?.config.seed ?? null,
      replay_of: run?.replayOf ?? null,
      events_generated: run?.eventsGenerated ?? 0,
      events_delivered: d?.delivered ?? 0,
      events_failed: d?.failed ?? 0,
      events_pending: d ? d.pending + d.in_flight : 0,
      events_dropped: d?.dropped ?? 0,
      events_skipped: d?.skipped ?? 0,
      events_cancelled: d?.cancelled ?? 0,
      events_invalid: run?.eventsInvalid ?? 0,
      delivery_retries: d?.retries ?? 0,
      last_event_at: run?.lastEventAt ?? null,
      last_delivery_at: d?.last_delivery_at ?? null,
      last_response_code: d?.last_status_code ?? null,
      last_delivery_error: d?.last_error ?? null,
      webhook_status: activeDestinations ? this.opts.delivery.health() : "disabled",
      webhook_target: {
        mode: activeDestinations ? mode : "none",
        host: describeTarget(mode === "custom" ? (run?.customTarget?.url ?? null) : defaultUrl),
        token_configured: Boolean(this.opts.config.webhookToken),
        destinations: activeDestinations,
      },
      match: run ? run.simulator.progress : null,
      failure_modes_enabled: Boolean(run?.config.failure_modes),
      started_at: run?.startedAt ?? null,
      ended_at: run?.endedAt ?? null,
      error: run?.error ?? null,
      queue_size: this.opts.delivery.size,
      recent_delivery_failures: runId ? this.opts.delivery.recentFailures(runId, 5) : [],
      uptime_seconds: Math.round((Date.now() - this.startedAtMs) / 1000),
      server_time: this.now().toISOString(),
    };
  }

  /** Every delivery destination: N8N_WEBHOOK_URL first, then dashboard webhooks. */
  destinations(): Destination[] {
    const list: Destination[] = [];
    const defaultUrl = usableWebhookUrl(this.opts.config);
    if (defaultUrl) {
      list.push({
        id: "default",
        name: "Primary n8n (N8N_WEBHOOK_URL)",
        source: "environment",
        ...displayUrl(defaultUrl),
        enabled: true,
        event_types: null,
        token_set: Boolean(this.opts.config.webhookToken),
        created_at: null,
        delivery: this.opts.delivery.targetStats("default"),
      });
    }
    for (const s of this.opts.subscriptions.list()) {
      list.push({
        id: s.id,
        name: s.name,
        source: "dashboard",
        host: s.host,
        url_display: s.url_display,
        enabled: s.enabled,
        event_types: s.event_types,
        token_set: s.token_set,
        created_at: s.created_at,
        delivery: this.opts.delivery.targetStats(s.id),
      });
    }
    return list;
  }

  /** The delivery target behind a destination ID ("default" or a dashboard webhook ID). */
  destinationTarget(id: string): WebhookTarget {
    if (id !== "default") return this.opts.subscriptions.target(id);
    const url = usableWebhookUrl(this.opts.config);
    if (!url) throw new EngineError(404, "webhook_not_found", "N8N_WEBHOOK_URL is not configured.");
    return { id: "default", name: "Primary n8n", url, token: this.opts.config.webhookToken };
  }

  /** Chart data for the current run: odds, one player's samples, and latest snapshots. */
  timeline(playerId = "player_07") {
    const run = this.run;
    const player = PLAYERS.some((p) => p.player_id === playerId)
      ? getPlayer(playerId)
      : getPlayer("player_07");
    const base = {
      player: {
        player_id: player.player_id,
        display_name: player.display_name,
        team_id: player.team_id,
        baseline: player.baseline as PlayerBaseline,
        samples: [] as SamplePoint[],
      },
    };
    if (!run) {
      return {
        run_id: null,
        status: this.state,
        match: null,
        odds: [],
        rounds: [],
        snapshots: [],
        ...base,
      };
    }
    const tl = run.timeline;
    return {
      run_id: run.runId,
      status: run.state,
      scenario: run.config.scenario,
      match: {
        ...run.simulator.progress,
        round_length_seconds: run.simulator.roundLength,
      },
      odds: tl.odds,
      rounds: tl.rounds,
      snapshots: PLAYERS.map((p) => ({
        player_id: p.player_id,
        display_name: p.display_name,
        team_id: p.team_id,
        baseline: p.baseline,
        latest: tl.snapshots.get(p.player_id) ?? null,
      })),
      player: { ...base.player, samples: tl.samples.get(player.player_id) ?? [] },
    };
  }

  runDetails(runIdParam: string): {
    run_id: string;
    status: RunState;
    config: RunConfig;
    progress: MatchProgress;
    truth: ScenarioTruth;
    recent_delivery_failures: FailedDelivery[];
  } {
    const run = this.requireCurrent(runIdParam);
    return {
      run_id: run.runId,
      status: run.state,
      config: run.config,
      progress: run.simulator.progress,
      truth: run.simulator.truth,
      recent_delivery_failures: this.opts.delivery.recentFailures(run.runId, 20),
    };
  }

  recentEvents(limit = 50): EmittedEvent[] {
    return this.recent.slice(-limit).reverse();
  }

  subscribe(listener: (e: EmittedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops timers and gives in-flight deliveries a short window to finish. */
  async shutdown(drainMs = 3000): Promise<void> {
    if (this.run && ACTIVE_STATES.includes(this.run.state)) {
      this.run.ticker.stop();
      this.run.state = "stopped";
      this.run.endedAt = this.now().toISOString();
    }
    await this.opts.delivery.drain(drainMs);
    const cancelled = this.opts.delivery.close();
    this.opts.logger.info({ cancelled_deliveries: cancelled }, "simulator engine shut down");
  }

  // ---------------------------------------------------------------------------
  // Internals

  private onTick(run: RunRecord): void {
    if (this.run !== run || run.state !== "running") return;
    try {
      const extras = run.faults?.burstExtras(run.simulator.progress.match_clock_seconds) ?? 0;
      for (const event of run.simulator.nextTick(extras)) this.emit(run, event);
      if (run.simulator.finished) {
        run.ticker.stop();
        run.state = "completed";
        run.endedAt = this.now().toISOString();
        this.opts.logger.info(
          {
            run_id: run.runId,
            events_generated: run.eventsGenerated,
            score: run.simulator.progress.score,
          },
          "run completed",
        );
      }
    } catch (err) {
      run.ticker.stop();
      run.state = "failed";
      run.endedAt = this.now().toISOString();
      run.error = err instanceof Error ? err.message : String(err);
      this.opts.logger.error({ run_id: run.runId, err }, "run failed");
    }
  }

  private emit(run: RunRecord, event: SimulatorEvent): void {
    const check = validateEvent(event);
    if (!check.success) {
      run.eventsInvalid++;
      this.opts.logger.error(
        {
          run_id: run.runId,
          event_id: event.event_id,
          event_type: event.event_type,
          issues: check.error.issues,
        },
        "generated event failed contract validation and was not sent",
      );
      return;
    }
    this.recordTimeline(run, event);
    const outgoing: OutgoingEvent[] = run.faults ? run.faults.apply(event) : [passThrough(event)];
    for (const o of outgoing) {
      run.eventsGenerated++;
      run.lastEventAt = this.now().toISOString();
      // Looked up per event, so a webhook added mid-run starts receiving immediately.
      const targets = this.targetsFor(run.targetMode, run.customTarget, o.eventType);
      for (const target of targets.length ? targets : [{ url: null, token: null }]) {
        this.opts.delivery.enqueue({
          runId: run.runId,
          target,
          payload: o.payload,
          eventId: o.eventId,
          eventType: o.eventType,
          sequence: o.sequence,
          fault: o.fault,
          delayMs: o.delayMs,
        });
      }
      if (o.fault) {
        this.opts.logger.info(
          { run_id: run.runId, event_id: o.eventId, fault: o.fault, delay_ms: o.delayMs },
          "fault injected",
        );
      }
      this.record({ emitted_at: run.lastEventAt, fault: o.fault, payload: o.payload });
    }
  }

  private recordTimeline(run: RunRecord, e: SimulatorEvent): void {
    const tl = run.timeline;
    const t = e.metadata.match_clock_seconds;
    if (e.event_type === "odds_update" && tl.odds.length < TIMELINE_LIMIT) {
      tl.odds.push({
        t,
        seq: e.sequence_number,
        team_blue: e.odds.team_blue,
        team_red: e.odds.team_red,
        movement_pct: e.odds.movement_pct,
        reason: e.data.reason,
      });
    } else if (e.event_type === "player_action") {
      const list = tl.samples.get(e.player_id) ?? [];
      if (list.length < TIMELINE_LIMIT) list.push({ t, ...e.metrics });
      tl.samples.set(e.player_id, list);
    } else if (e.event_type === "player_snapshot") {
      tl.snapshots.set(e.player_id, { t, metrics: e.metrics });
    } else if (e.event_type === "round_ended") {
      tl.rounds.push({
        t,
        round_number: e.data.round_number,
        winner_team_id: e.data.winner_team_id,
      });
    }
  }

  private targetsFor(
    mode: RunRecord["targetMode"],
    customTarget: WebhookTarget | null,
    eventType: string,
  ): WebhookTarget[] {
    if (mode === "none") return [];
    if (mode === "custom") return customTarget ? [customTarget] : [];
    const list = usableWebhookUrl(this.opts.config) ? [this.destinationTarget("default")] : [];
    return list.concat(this.opts.subscriptions.targetsFor(eventType));
  }

  private emitStatus(run: RunRecord): void {
    if (!run.config.emit_status_events) return;
    this.emit(run, run.simulator.statusEvent(run.state, run.eventsGenerated));
  }

  private record(e: EmittedEvent): void {
    this.recent.push(e);
    if (this.recent.length > RECENT_EVENT_LIMIT) this.recent.shift();
    for (const listener of this.listeners) {
      try {
        listener(e);
      } catch {
        // A broken preview stream must never affect the run.
      }
    }
  }

  private resolveMode(
    config: Pick<RunConfig, "webhook_url">,
    allowMissing = false,
  ): { customTarget: WebhookTarget | null; mode: RunRecord["targetMode"]; warnings: string[] } {
    const warnings: string[] = [];
    const defaultUrl = usableWebhookUrl(this.opts.config);
    if (config.webhook_url === "none") {
      return { customTarget: null, mode: "none", warnings: ["Dry run: events are not delivered"] };
    }
    if (config.webhook_url && config.webhook_url !== "configured-default") {
      // Only send the shared token to the configured n8n origin, never to an arbitrary URL.
      const sameOrigin =
        defaultUrl !== null && new URL(defaultUrl).origin === new URL(config.webhook_url).origin;
      return {
        customTarget: {
          id: "custom",
          name: "Custom URL",
          url: config.webhook_url,
          token: sameOrigin ? this.opts.config.webhookToken : null,
        },
        mode: "custom",
        warnings,
      };
    }
    if (!defaultUrl && this.opts.subscriptions.enabledCount === 0) {
      if (this.opts.config.nodeEnv === "production" && !allowMissing) {
        throw new EngineError(
          503,
          "webhook_not_configured",
          'No webhook destination. Add one in the dashboard (Webhooks tab), set N8N_WEBHOOK_URL, or pass "webhook_url": "none" for a dry run.',
        );
      }
      warnings.push("No webhook destination yet: events are generated but not delivered");
    }
    return { customTarget: null, mode: "configured-default", warnings };
  }

  private resolveRunId(param: string): string {
    if (param === "current" || param === "latest") {
      const id = this.run?.runId ?? this.lastRunId;
      if (!id) throw new EngineError(404, "run_not_found", "No run has been started yet.");
      return id;
    }
    if (param === this.run?.runId || param === this.lastRunId) return param;
    throw new EngineError(
      404,
      "run_not_found",
      `Run ${param} is not the current or most recent run.`,
    );
  }

  private requireCurrent(param: string): RunRecord {
    const runId = this.resolveRunId(param);
    if (!this.run || this.run.runId !== runId) {
      throw new EngineError(
        409,
        "run_reset",
        `Run ${runId} has been reset. Start or replay a run.`,
      );
    }
    return this.run;
  }

  private badState(run: RunRecord, action: string, required: string): EngineError {
    return new EngineError(
      409,
      "invalid_state",
      `Cannot ${action} run ${run.runId}: it is ${run.state}, not ${required}.`,
    );
  }

  private summary(run: RunRecord, warnings: string[] = []): RunSummary {
    return {
      run_id: run.runId,
      status: run.state,
      scenario: run.config.scenario,
      preset: run.config.preset,
      started_at: run.startedAt,
      seed: run.config.seed,
      match_id: run.simulator.matchId,
      replay_of: run.replayOf,
      webhook_mode: run.targetMode,
      warnings,
    };
  }
}
