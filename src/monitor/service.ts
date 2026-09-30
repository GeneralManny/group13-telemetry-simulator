import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { SimulatorEvent } from "../contracts/events.js";
import { PLAYERS } from "../data/players.js";
import { summarizeCase, type AiConfig, type SummaryResult } from "./ai.js";
import { migrate, seedReference, transaction, type Client, type Pool } from "./db/database.js";
import {
  alertDecision,
  evaluateMarket,
  evaluateOddsUpdate,
  evaluatePlayer,
  METRICS,
  type OddsSignal,
  type PlayerBaselines,
  type RiskResult,
  type RuleHit,
  type TeamId,
} from "./engine/risk.js";
import {
  DEFAULT_THRESHOLDS,
  SEVERITY_RANK,
  severityFor,
  ThresholdsSchema,
  type Severity,
  type Thresholds,
} from "./engine/thresholds.js";
import type { EvidencePacket } from "./evidence.js";

export class MonitorError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const REVIEW_ACTIONS = ["approve_for_investigation", "dismiss", "escalate"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
const ACTION_STATUS: Record<ReviewAction, string> = {
  approve_for_investigation: "approved",
  dismiss: "dismissed",
  escalate: "escalated",
};
const FINAL_STATUSES = new Set(["approved", "dismissed"]);

export interface AlertInstruction {
  needed: boolean;
  case_id: string;
  severity: Severity;
  score: number;
  reason: "new_case" | "severity_increase";
}

export interface IngestResult {
  stored: boolean;
  duplicate: boolean;
  event_id: string;
  match_id: string;
  trace_id: string | null;
  results: {
    subject: string;
    status: string;
    score: number;
    severity: Severity;
    case_id: string | null;
  }[];
  alerts: AlertInstruction[];
}

export interface MonitorOptions {
  ai: AiConfig;
  publicBaseUrl: string | null;
}

interface CaseRow {
  case_id: string;
  match_id: string;
  subject_key: string;
  subject_type: string;
  player_id: string | null;
  team_id: string | null;
  simulator_run_id: string | null;
  status: string;
  severity: Severity;
  score: number;
  peak_score: number;
  components: RiskResult["components"];
  rules: RuleHit[];
  window_start: number | null;
  window_end: number | null;
  trace_id: string | null;
  alerted_severity: Severity | null;
  alert_status: string;
  alert_attempts: number;
  alert_error: string | null;
  alerted_at: string | null;
  ai_status: string;
  ai_summary: string | null;
  ai_model: string | null;
  ai_generated_at: string | null;
  reviewer: string | null;
  review_notes: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

const newCaseId = () =>
  `CASE-${randomBytes(4).toString("base64url").replace(/[-_]/g, "X").slice(0, 6).toUpperCase()}`;

/**
 * The monitor: stores events once, scores them with the risk engine, opens and updates cases,
 * and records AI summaries, alert delivery and human review. n8n drives it over HTTP.
 */
export class MonitorService {
  private thresholds: Thresholds = DEFAULT_THRESHOLDS;
  private thresholdsLoadedAt = 0;
  private baselines = new Map<string, PlayerBaselines>();
  private ready = false;

  constructor(
    readonly pool: Pool,
    private readonly logger: Logger,
    private readonly opts: MonitorOptions,
  ) {}

  get isReady(): boolean {
    return this.ready;
  }

  get aiConfigured(): boolean {
    return Boolean(this.opts.ai.apiKey);
  }

  async init(): Promise<void> {
    await migrate(this.pool, this.logger);
    await seedReference(this.pool, this.logger);
    await this.loadBaselines();
    await this.loadThresholds(true);
    this.ready = true;
  }

  // ---------------------------------------------------------------------------
  // Reference data

  private async loadBaselines(): Promise<void> {
    const { rows } = await this.pool.query<{
      player_id: string;
      metric: string;
      mean: number;
      stddev: number;
      sample_size: number;
    }>("SELECT player_id, metric, mean, stddev, sample_size FROM monitor.baselines");
    const map = new Map<string, PlayerBaselines>();
    for (const r of rows) {
      const b = map.get(r.player_id) ?? ({} as PlayerBaselines);
      b[r.metric as keyof PlayerBaselines] = {
        mean: r.mean,
        stddev: r.stddev,
        sample_size: r.sample_size,
      };
      map.set(r.player_id, b);
    }
    // A player counts as having a baseline only when all four metrics exist.
    for (const [id, b] of map) if (METRICS.some((m) => !b[m])) map.delete(id);
    this.baselines = map;
  }

  async getThresholds(): Promise<Thresholds> {
    await this.loadThresholds(false);
    return this.thresholds;
  }

  private async loadThresholds(force: boolean): Promise<void> {
    if (!force && Date.now() - this.thresholdsLoadedAt < 30_000) return;
    const { rows } = await this.pool.query<{ value: unknown }>(
      "SELECT value FROM monitor.settings WHERE key = 'thresholds'",
    );
    const parsed = ThresholdsSchema.safeParse(rows[0]?.value);
    this.thresholds = parsed.success ? parsed.data : DEFAULT_THRESHOLDS;
    this.thresholdsLoadedAt = Date.now();
  }

  async updateThresholds(value: unknown): Promise<Thresholds> {
    const parsed = ThresholdsSchema.parse(value);
    await this.pool.query(
      `INSERT INTO monitor.settings (key, value, updated_at) VALUES ('thresholds', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(parsed)],
    );
    await this.loadThresholds(true);
    return parsed;
  }

  // ---------------------------------------------------------------------------
  // Ingestion

  async ingest(e: SimulatorEvent, traceId: string | null): Promise<IngestResult> {
    const t = await this.getThresholds();
    const clock = e.metadata.match_clock_seconds;
    return transaction(this.pool, async (c) => {
      const base: IngestResult = {
        stored: false,
        duplicate: false,
        event_id: e.event_id,
        match_id: e.match_id,
        trace_id: traceId,
        results: [],
        alerts: [],
      };
      const inserted = await c.query(
        `INSERT INTO monitor.events (event_id, event_type, schema_version, event_timestamp, tournament_id, match_id,
           round_id, player_id, team_id, sequence_number, scenario, simulator_run_id, match_clock_seconds,
           metrics, odds, data, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [
          e.event_id,
          e.event_type,
          e.schema_version,
          e.timestamp,
          e.tournament_id,
          e.match_id,
          e.round_id,
          e.player_id,
          e.team_id,
          e.sequence_number,
          e.scenario,
          e.simulator_run_id,
          clock,
          JSON.stringify(e.metrics),
          JSON.stringify(e.odds),
          JSON.stringify(e.data),
          traceId,
        ],
      );
      if (!inserted.rowCount) return { ...base, duplicate: true };
      base.stored = true;

      await this.updateMatch(c, e, clock);

      const risks: RiskResult[] = [];
      // Odds moves are judged once their explaining window has passed; the end of the match
      // settles any that are still waiting.
      const horizon = e.event_type === "match_ended" ? Number.POSITIVE_INFINITY : clock;
      risks.push(...(await this.judgePendingOdds(c, e.match_id, horizon, t)));

      if (e.event_type === "player_action") {
        risks.push(
          await this.scorePlayer(c, e.match_id, e.player_id, e.team_id as TeamId, clock, t),
        );
      }

      for (const r of risks) {
        const subject = r.subject.type === "player" ? r.subject.player_id : "market";
        let caseId: string | null = null;
        if (r.status === "scored" && SEVERITY_RANK[r.severity] >= SEVERITY_RANK.high) {
          const outcome = await this.upsertCase(c, e, r, traceId, t);
          caseId = outcome.case_id;
          if (outcome.alert) base.alerts.push(outcome.alert);
        }
        await c.query(
          `INSERT INTO monitor.risk_results (event_id, match_id, subject_key, player_id, status, score, severity,
             components, rules, source_event_ids, window_start, window_end, case_id, trace_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            e.event_id,
            e.match_id,
            subject,
            r.subject.type === "player" ? r.subject.player_id : null,
            r.status,
            r.score,
            r.severity,
            JSON.stringify(r.components),
            JSON.stringify(r.rules),
            r.source_event_ids,
            r.window.start,
            r.window.end,
            caseId,
            traceId,
          ],
        );
        base.results.push({
          subject,
          status: r.status,
          score: r.score,
          severity: r.severity,
          case_id: caseId,
        });
      }
      return base;
    });
  }

  private async updateMatch(c: Client, e: SimulatorEvent, clock: number): Promise<void> {
    const score =
      e.event_type === "round_ended"
        ? e.data.score
        : e.event_type === "match_ended"
          ? e.data.final_score
          : e.event_type === "round_started"
            ? e.data.score
            : null;
    await c.query(
      `INSERT INTO monitor.matches (match_id, tournament_id, simulator_run_id, scenario, status, total_rounds,
         started_at, match_clock_seconds, events_stored, last_event_at)
       VALUES ($1, $2, $3, $4, 'live', $5, $6, $7, 1, now())
       ON CONFLICT (match_id) DO UPDATE SET
         events_stored = monitor.matches.events_stored + 1,
         last_event_at = now(),
         match_clock_seconds = GREATEST(monitor.matches.match_clock_seconds, EXCLUDED.match_clock_seconds),
         total_rounds = COALESCE(EXCLUDED.total_rounds, monitor.matches.total_rounds)`,
      [
        e.match_id,
        e.tournament_id,
        e.simulator_run_id,
        e.scenario,
        e.event_type === "match_started" ? e.data.total_rounds : null,
        e.event_type === "match_started" ? e.timestamp : null,
        clock,
      ],
    );
    if (score) {
      await c.query(
        "UPDATE monitor.matches SET score_blue = $2, score_red = $3 WHERE match_id = $1",
        [e.match_id, score.team_blue, score.team_red],
      );
    }
    if (e.event_type === "round_started") {
      await c.query("UPDATE monitor.matches SET round_number = $2 WHERE match_id = $1", [
        e.match_id,
        e.data.round_number,
      ]);
    }
    if (e.event_type === "match_ended") {
      await c.query(
        "UPDATE monitor.matches SET status = 'ended', ended_at = $2 WHERE match_id = $1",
        [e.match_id, e.timestamp],
      );
    }
  }

  private async judgePendingOdds(
    c: Client,
    matchId: string,
    horizon: number,
    t: Thresholds,
  ): Promise<RiskResult[]> {
    const limit = Number.isFinite(horizon) ? horizon - t.odds_explained_gap_seconds : 1e12;
    const { rows } = await c.query<{
      event_id: string;
      t: number;
      odds: Record<string, number>;
      reason: string;
    }>(
      `SELECT e.event_id, e.match_clock_seconds AS t, e.odds, e.data->>'reason' AS reason
       FROM monitor.events e LEFT JOIN monitor.odds_checks oc ON oc.event_id = e.event_id
       WHERE e.match_id = $1 AND e.event_type = 'odds_update' AND oc.event_id IS NULL
         AND e.match_clock_seconds <= $2
       ORDER BY e.match_clock_seconds`,
      [matchId, limit],
    );
    const out: RiskResult[] = [];
    for (const r of rows) {
      const gap = t.odds_explained_gap_seconds;
      const rounds = await c.query<{ t: number }>(
        `SELECT match_clock_seconds AS t FROM monitor.events
         WHERE match_id = $1 AND event_type IN ('round_started', 'round_ended')
           AND match_clock_seconds BETWEEN $2 AND $3`,
        [matchId, r.t - gap, r.t + gap],
      );
      const update = {
        event_id: r.event_id,
        t: r.t,
        reason: r.reason,
        team_blue: Number(r.odds.team_blue),
        team_red: Number(r.odds.team_red),
        previous_team_blue: Number(r.odds.previous_team_blue),
        previous_team_red: Number(r.odds.previous_team_red),
        movement_pct: Number(r.odds.movement_pct),
      };
      const signal = evaluateOddsUpdate(
        update,
        rounds.rows.map((x) => x.t),
        t,
      );
      const verdict = signal
        ? "unexplained"
        : update.reason === "market_update" && update.movement_pct >= t.odds_trigger_pct
          ? "explained"
          : "normal";
      const ins = await c.query(
        `INSERT INTO monitor.odds_checks (event_id, match_id, match_clock, verdict, movement_pct, shortened_team, points, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [
          r.event_id,
          matchId,
          r.t,
          verdict,
          update.movement_pct,
          signal?.shortened_team ?? null,
          signal?.points ?? 0,
          JSON.stringify(signal ? { from: signal.from, to: signal.to } : {}),
        ],
      );
      if (signal && ins.rowCount) out.push(evaluateMarket(signal, t));
    }
    return out;
  }

  private async oddsSignals(c: Client, matchId: string): Promise<OddsSignal[]> {
    const { rows } = await c.query<{
      event_id: string;
      match_clock: number;
      movement_pct: number;
      shortened_team: TeamId;
      points: number;
      detail: { from: OddsSignal["from"]; to: OddsSignal["to"] };
    }>(
      `SELECT event_id, match_clock, movement_pct, shortened_team, points, detail FROM monitor.odds_checks
       WHERE match_id = $1 AND verdict = 'unexplained' ORDER BY match_clock`,
      [matchId],
    );
    return rows.map((r) => ({
      event_id: r.event_id,
      t: r.match_clock,
      movement_pct: r.movement_pct,
      shortened_team: r.shortened_team,
      points: r.points,
      from: r.detail.from,
      to: r.detail.to,
    }));
  }

  private async scorePlayer(
    c: Client,
    matchId: string,
    playerId: string,
    teamId: TeamId,
    clock: number,
    t: Thresholds,
  ): Promise<RiskResult> {
    const { rows } = await c.query<{
      event_id: string;
      t: number;
      metrics: Record<string, number>;
    }>(
      `SELECT event_id, match_clock_seconds AS t, metrics FROM monitor.events
       WHERE match_id = $1 AND player_id = $2 AND event_type = 'player_action'
         AND match_clock_seconds BETWEEN $3 AND $4
       ORDER BY match_clock_seconds`,
      [matchId, playerId, clock - t.window_seconds, clock],
    );
    const samples = rows.map((r) => ({
      event_id: r.event_id,
      t: r.t,
      reaction_time_ms: Number(r.metrics.reaction_time_ms),
      accuracy_pct: Number(r.metrics.accuracy_pct),
      headshot_pct: Number(r.metrics.headshot_pct),
      actions_per_minute: Number(r.metrics.actions_per_minute),
    }));
    return evaluatePlayer(
      {
        player_id: playerId,
        team_id: teamId,
        t: clock,
        samples,
        baselines: this.baselines.get(playerId) ?? null,
        oddsSignals: await this.oddsSignals(c, matchId),
      },
      t,
    );
  }

  private async upsertCase(
    c: Client,
    e: SimulatorEvent,
    r: RiskResult,
    traceId: string | null,
    t: Thresholds,
  ): Promise<{ case_id: string; alert: AlertInstruction | null }> {
    const subjectKey = r.subject.type === "player" ? r.subject.player_id : "market";
    const created = await c.query<{ case_id: string }>(
      `INSERT INTO monitor.cases (case_id, match_id, subject_key, subject_type, player_id, team_id, simulator_run_id,
         severity, score, peak_score, components, rules, window_start, window_end, trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (match_id, subject_key) DO NOTHING RETURNING case_id`,
      [
        newCaseId(),
        e.match_id,
        subjectKey,
        r.subject.type,
        r.subject.type === "player" ? r.subject.player_id : null,
        r.subject.type === "player" ? r.subject.team_id : null,
        e.simulator_run_id,
        r.severity,
        r.score,
        JSON.stringify(r.components),
        JSON.stringify(r.rules),
        r.window.start,
        r.window.end,
        traceId,
      ],
    );
    const { rows } = await c.query<CaseRow>(
      "SELECT * FROM monitor.cases WHERE match_id = $1 AND subject_key = $2 FOR UPDATE",
      [e.match_id, subjectKey],
    );
    const row = rows[0]!;
    if (created.rowCount) {
      await this.audit(c, row.case_id, null, "open", "risk-engine", `Opened at score ${r.score}`);
    } else {
      // The case keeps the rules and components of its highest-scoring evaluation, which is the
      // clearest explanation, while score tracks the latest evaluation.
      const peak = r.score > row.peak_score;
      await c.query(
        `UPDATE monitor.cases SET score = $2, window_end = GREATEST(window_end, $3), updated_at = now()
           ${peak ? ", peak_score = $2, severity = $4, components = $5, rules = $6" : ""}
         WHERE case_id = $1`,
        peak
          ? [
              row.case_id,
              r.score,
              r.window.end,
              severityFor(r.score, t),
              JSON.stringify(r.components),
              JSON.stringify(r.rules),
            ]
          : [row.case_id, r.score, r.window.end],
      );
      if (peak) {
        row.peak_score = r.score;
        row.severity = severityFor(r.score, t);
      }
    }

    for (const id of r.source_event_ids) {
      const kind = r.rules.some(
        (x) => x.rule_id === "ODDS_UNEXPLAINED_MOVE" && x.source_event_ids.includes(id),
      )
        ? "odds_update"
        : "player_action";
      await c.query(
        "INSERT INTO monitor.evidence (case_id, event_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [row.case_id, id, kind],
      );
    }

    if (FINAL_STATUSES.has(row.status)) return { case_id: row.case_id, alert: null };
    const decision = alertDecision(row.alerted_severity, row.severity, t);
    if (!decision.needed || !decision.reason) return { case_id: row.case_id, alert: null };
    // Recorded now, inside the locked row, so a concurrent event cannot alert for the same step.
    await c.query(
      "UPDATE monitor.cases SET alerted_severity = $2, alert_status = 'pending' WHERE case_id = $1",
      [row.case_id, row.severity],
    );
    return {
      case_id: row.case_id,
      alert: {
        needed: true,
        case_id: row.case_id,
        severity: row.severity,
        score: row.peak_score,
        reason: decision.reason,
      },
    };
  }

  private async audit(
    c: Client | Pool,
    caseId: string,
    from: string | null,
    to: string,
    actor: string,
    note: string | null,
  ): Promise<void> {
    await c.query(
      "INSERT INTO monitor.case_audit (case_id, from_status, to_status, actor, note) VALUES ($1,$2,$3,$4,$5)",
      [caseId, from, to, actor, note],
    );
  }

  async addDeadLetter(d: {
    reason: string;
    error?: string | null;
    payload?: unknown;
    event_id?: string | null;
    trace_id?: string | null;
  }): Promise<{ id: number }> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO monitor.dead_letters (reason, error, payload, event_id, trace_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        d.reason,
        d.error ?? null,
        JSON.stringify(d.payload ?? null),
        d.event_id ?? null,
        d.trace_id ?? null,
      ],
    );
    return { id: Number(rows[0]!.id) };
  }

  // ---------------------------------------------------------------------------
  // Evidence, AI summary, alert and review

  private async caseRow(
    caseId: string,
    c: Client | Pool = this.pool,
    lock = false,
  ): Promise<CaseRow> {
    const { rows } = await c.query<CaseRow>(
      `SELECT * FROM monitor.cases WHERE case_id = $1${lock ? " FOR UPDATE" : ""}`,
      [caseId],
    );
    if (!rows[0]) throw new MonitorError(404, "case_not_found", `No case ${caseId}.`);
    return rows[0];
  }

  async evidencePacket(caseId: string): Promise<EvidencePacket> {
    const row = await this.caseRow(caseId);
    const match = (
      await this.pool.query<{
        tournament_id: string | null;
        simulator_run_id: string | null;
        match_clock_seconds: number;
        score_blue: number;
        score_red: number;
      }>("SELECT * FROM monitor.matches WHERE match_id = $1", [row.match_id])
    ).rows[0];
    const player = row.player_id ? PLAYERS.find((p) => p.player_id === row.player_id) : undefined;
    const baselineRows = row.player_id
      ? (
          await this.pool.query<{
            metric: string;
            mean: number;
            stddev: number;
            sample_size: number;
          }>(
            "SELECT metric, mean, stddev, sample_size FROM monitor.baselines WHERE player_id = $1",
            [row.player_id],
          )
        ).rows
      : [];
    const perfRules = new Map(row.rules.filter((r) => r.metric).map((r) => [r.metric!, r]));
    const odds = (
      await this.pool.query<{
        event_id: string;
        match_clock: number;
        movement_pct: number;
        shortened_team: string | null;
        detail: { from?: unknown; to?: unknown };
      }>(
        `SELECT event_id, match_clock, movement_pct, shortened_team, detail FROM monitor.odds_checks
         WHERE match_id = $1 AND verdict = 'unexplained' ORDER BY match_clock`,
        [row.match_id],
      )
    ).rows;
    const samples = (
      await this.pool.query<{
        event_id: string;
        match_clock_seconds: number;
        event_type: string;
        metrics: Record<string, unknown>;
      }>(
        `SELECT e.event_id, e.match_clock_seconds, e.event_type, e.metrics FROM monitor.evidence ev
         JOIN monitor.events e ON e.event_id = ev.event_id
         WHERE ev.case_id = $1 ORDER BY e.match_clock_seconds DESC LIMIT 12`,
        [caseId],
      )
    ).rows;
    const evidenceCount = Number(
      (
        await this.pool.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM monitor.evidence WHERE case_id = $1",
          [caseId],
        )
      ).rows[0]?.n ?? 0,
    );

    return {
      case_id: row.case_id,
      severity: row.severity,
      score: row.peak_score,
      peak_score: row.peak_score,
      status: row.status,
      match: {
        match_id: row.match_id,
        tournament_id: match?.tournament_id ?? null,
        simulator_run_id: row.simulator_run_id,
        match_clock_seconds: match?.match_clock_seconds ?? 0,
        score: { team_blue: match?.score_blue ?? 0, team_red: match?.score_red ?? 0 },
      },
      subject:
        row.subject_type === "player" && player
          ? {
              type: "player",
              player_id: player.player_id,
              display_name: player.display_name,
              team_id: player.team_id,
            }
          : { type: "market" },
      components: row.components,
      rules: row.rules,
      window: { start: row.window_start, end: row.window_end },
      metrics_vs_baseline: baselineRows.map((b) => {
        const rule = perfRules.get(b.metric as RuleHit["metric"] & string);
        return {
          metric: b.metric,
          baseline_mean: b.mean,
          baseline_stddev: b.stddev,
          baseline_sample_size: b.sample_size,
          window_average: rule?.observed ?? null,
          deviation_sd: rule?.deviation_sd ?? null,
        };
      }),
      odds_moves: odds.map((o) => ({
        event_id: o.event_id,
        match_clock: o.match_clock,
        movement_pct: o.movement_pct,
        shortened_team: o.shortened_team,
        from: o.detail.from ?? null,
        to: o.detail.to ?? null,
      })),
      sample_events: samples.map((s) => ({
        event_id: s.event_id,
        match_clock: s.match_clock_seconds,
        event_type: s.event_type,
        metrics: s.metrics,
      })),
      evidence_event_count: evidenceCount,
      case_url: this.opts.publicBaseUrl
        ? `${this.opts.publicBaseUrl}/?case=${row.case_id}#cases`
        : null,
    };
  }

  /** Generates (or regenerates) the case summary. Falls back to the template on any AI failure. */
  async summarize(caseId: string): Promise<SummaryResult & { case_status: string }> {
    const packet = await this.evidencePacket(caseId);
    const result = await summarizeCase(packet, this.opts.ai, this.logger);
    return transaction(this.pool, async (c) => {
      const row = await this.caseRow(caseId, c, true);
      const next = row.status === "open" ? "pending_review" : row.status;
      await c.query(
        `UPDATE monitor.cases SET ai_status = $2, ai_summary = $3, ai_model = $4, ai_generated_at = now(),
           status = $5, updated_at = now() WHERE case_id = $1`,
        [caseId, result.status, result.text, result.model, next],
      );
      if (next !== row.status) {
        await this.audit(
          c,
          caseId,
          row.status,
          next,
          "evidence-workflow",
          `Summary ${result.status}`,
        );
      }
      return { ...result, case_status: next };
    });
  }

  async recordAlert(caseId: string, a: { status: "sent" | "failed"; error?: string | null }) {
    return transaction(this.pool, async (c) => {
      const row = await this.caseRow(caseId, c, true);
      await c.query(
        `UPDATE monitor.cases SET alert_status = $2, alert_attempts = alert_attempts + 1, alert_error = $3,
           alerted_at = CASE WHEN $2 = 'sent' THEN now() ELSE alerted_at END, updated_at = now() WHERE case_id = $1`,
        [caseId, a.status, a.error ?? null],
      );
      // A case becomes reviewable once its evidence is summarised, whether or not Slack delivered.
      if (row.status === "open") {
        await c.query("UPDATE monitor.cases SET status = 'pending_review' WHERE case_id = $1", [
          caseId,
        ]);
        await this.audit(
          c,
          caseId,
          "open",
          "pending_review",
          "evidence-workflow",
          `Alert ${a.status}`,
        );
      }
      return { case_id: caseId, alert_status: a.status };
    });
  }

  async review(
    caseId: string,
    r: { action: ReviewAction; reviewer: string; notes: string | null; channel: string },
  ): Promise<{ case_id: string; status: string; duplicate: boolean }> {
    return transaction(this.pool, async (c) => {
      const row = await this.caseRow(caseId, c, true);
      const target = ACTION_STATUS[r.action];
      if (row.status === target) return { case_id: caseId, status: target, duplicate: true };
      if (FINAL_STATUSES.has(row.status)) {
        throw new MonitorError(
          409,
          "case_already_reviewed",
          `Case ${caseId} is already ${row.status} by ${row.reviewer ?? "a reviewer"}. Final decisions are not changed.`,
        );
      }
      await c.query(
        "INSERT INTO monitor.reviews (case_id, action, reviewer, notes, channel) VALUES ($1,$2,$3,$4,$5)",
        [caseId, r.action, r.reviewer, r.notes, r.channel],
      );
      await c.query(
        `UPDATE monitor.cases SET status = $2, reviewer = $3, review_notes = $4, reviewed_at = now(), updated_at = now()
         WHERE case_id = $1`,
        [caseId, target, r.reviewer, r.notes],
      );
      await this.audit(c, caseId, row.status, target, r.reviewer, r.notes);
      return { case_id: caseId, status: target, duplicate: false };
    });
  }

  // ---------------------------------------------------------------------------
  // Read models for the dashboard

  async listCases(f: {
    status?: string;
    severity?: string;
    match_id?: string;
    player_id?: string;
    limit?: number;
  }) {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace("?", `$${args.length}`));
    };
    if (f.status) add("status = ?", f.status);
    if (f.severity) add("severity = ?", f.severity);
    if (f.match_id) add("match_id = ?", f.match_id);
    if (f.player_id) add("player_id = ?", f.player_id);
    args.push(Math.min(200, f.limit ?? 50));
    const { rows } = await this.pool.query(
      `SELECT case_id, match_id, subject_type, player_id, team_id, status, severity, score, peak_score,
         alert_status, ai_status, reviewer, reviewed_at, created_at, updated_at, window_start, window_end,
         (SELECT jsonb_agg(r->>'rule_id') FROM jsonb_array_elements(rules) r WHERE (r->>'points')::int > 0) AS rule_ids
       FROM monitor.cases ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY updated_at DESC LIMIT $${args.length}`,
      args,
    );
    return rows.map((r) => ({
      ...r,
      display_name: PLAYERS.find((p) => p.player_id === r.player_id)?.display_name ?? null,
    }));
  }

  async caseDetail(caseId: string) {
    const row = await this.caseRow(caseId);
    const packet = await this.evidencePacket(caseId);
    const reviews = (
      await this.pool.query(
        "SELECT action, reviewer, notes, channel, created_at FROM monitor.reviews WHERE case_id = $1 ORDER BY created_at",
        [caseId],
      )
    ).rows;
    const audit = (
      await this.pool.query(
        "SELECT from_status, to_status, actor, note, at FROM monitor.case_audit WHERE case_id = $1 ORDER BY at",
        [caseId],
      )
    ).rows;
    const history = (
      await this.pool.query(
        `SELECT score, severity, window_end AS t, calculated_at FROM monitor.risk_results
         WHERE match_id = $1 AND subject_key = $2 ORDER BY window_end, id`,
        [row.match_id, row.subject_key],
      )
    ).rows;
    return {
      case: {
        case_id: row.case_id,
        status: row.status,
        severity: row.severity,
        score: row.score,
        peak_score: row.peak_score,
        alert_status: row.alert_status,
        alert_attempts: row.alert_attempts,
        alert_error: row.alert_error,
        alerted_at: row.alerted_at,
        ai_status: row.ai_status,
        ai_summary: row.ai_summary,
        ai_model: row.ai_model,
        ai_generated_at: row.ai_generated_at,
        reviewer: row.reviewer,
        review_notes: row.review_notes,
        reviewed_at: row.reviewed_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        trace_id: row.trace_id,
      },
      evidence: packet,
      score_history: history,
      reviews,
      audit,
    };
  }

  async overview() {
    const match =
      (
        await this.pool.query(
          "SELECT * FROM monitor.matches ORDER BY last_event_at DESC NULLS LAST LIMIT 1",
        )
      ).rows[0] ?? null;
    const counts = (
      await this.pool.query<{
        events: string;
        last_minute: string;
        dead_letters: string;
        last_event_at: string | null;
      }>(
        `SELECT (SELECT count(*) FROM monitor.events)::text AS events,
                (SELECT count(*) FROM monitor.events WHERE received_at > now() - interval '60 seconds')::text AS last_minute,
                (SELECT count(*) FROM monitor.dead_letters)::text AS dead_letters,
                (SELECT max(received_at) FROM monitor.events) AS last_event_at`,
      )
    ).rows[0]!;
    const byStatus = (
      await this.pool.query<{ status: string; n: string }>(
        "SELECT status, count(*)::text AS n FROM monitor.cases GROUP BY status",
      )
    ).rows;
    const lastAt = counts.last_event_at ? Date.parse(counts.last_event_at) : null;
    return {
      pipeline: {
        status: lastAt === null ? "waiting" : Date.now() - lastAt < 15_000 ? "receiving" : "idle",
        events_stored: Number(counts.events),
        events_last_minute: Number(counts.last_minute),
        dead_letters: Number(counts.dead_letters),
        last_event_at: counts.last_event_at,
        ai_configured: this.aiConfigured,
      },
      match,
      cases: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
      thresholds: (await this.getThresholds()).severity,
    };
  }

  /** Latest risk per player in the most recent match, with their baselines. */
  async playerRisk() {
    const match = (
      await this.pool.query<{ match_id: string }>(
        "SELECT match_id FROM monitor.matches ORDER BY last_event_at DESC NULLS LAST LIMIT 1",
      )
    ).rows[0];
    const latest = match
      ? (
          await this.pool.query<{
            subject_key: string;
            score: number;
            severity: string;
            status: string;
            rules: RuleHit[];
            calculated_at: string;
          }>(
            `SELECT DISTINCT ON (subject_key) subject_key, score, severity, status, rules, calculated_at
             FROM monitor.risk_results WHERE match_id = $1 ORDER BY subject_key, id DESC`,
            [match.match_id],
          )
        ).rows
      : [];
    const peak = match
      ? (
          await this.pool.query<{ subject_key: string; peak: number }>(
            "SELECT subject_key, max(score) AS peak FROM monitor.risk_results WHERE match_id = $1 GROUP BY subject_key",
            [match.match_id],
          )
        ).rows
      : [];
    const bl = (await this.pool.query("SELECT * FROM monitor.baselines ORDER BY player_id, metric"))
      .rows;
    const subjects = [...PLAYERS.map((p) => p.player_id), "market"];
    return {
      match_id: match?.match_id ?? null,
      subjects: subjects.map((id) => {
        const l = latest.find((x) => x.subject_key === id);
        const p = PLAYERS.find((x) => x.player_id === id);
        return {
          subject: id,
          display_name: p?.display_name ?? "Betting market",
          team_id: p?.team_id ?? null,
          score: l?.score ?? 0,
          severity: l?.severity ?? "normal",
          status: l?.status ?? "no_data",
          peak_score: Number(peak.find((x) => x.subject_key === id)?.peak ?? 0),
          rules: (l?.rules ?? []).filter((r) => r.points > 0).map((r) => r.rule_id),
          updated_at: l?.calculated_at ?? null,
          baseline: bl.filter((b) => b.player_id === id),
        };
      }),
    };
  }

  async deadLetters(limit = 50) {
    return (
      await this.pool.query(
        "SELECT id, received_at, event_id, reason, error, payload, trace_id, retry_status FROM monitor.dead_letters ORDER BY id DESC LIMIT $1",
        [Math.min(200, limit)],
      )
    ).rows;
  }

  async recentEvents(limit = 50) {
    return (
      await this.pool.query(
        `SELECT event_id, event_type, match_id, player_id, sequence_number, match_clock_seconds, received_at, trace_id
         FROM monitor.events ORDER BY received_at DESC LIMIT $1`,
        [Math.min(200, limit)],
      )
    ).rows;
  }

  /** Clears run data for a fresh demo. Players, baselines and thresholds are kept. */
  async reset(actor: string): Promise<{ cleared: true }> {
    await this.pool.query(
      `TRUNCATE monitor.events, monitor.risk_results, monitor.cases, monitor.evidence, monitor.reviews,
         monitor.case_audit, monitor.odds_checks, monitor.dead_letters, monitor.matches`,
    );
    this.logger.info({ actor }, "monitor data reset (baselines and thresholds kept)");
    return { cleared: true };
  }
}
