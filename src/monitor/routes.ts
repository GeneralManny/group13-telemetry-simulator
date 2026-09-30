import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SimulatorEventSchema } from "../contracts/events.js";
import { RequestValidationError, formatZodIssues } from "../contracts/validation.js";
import type { Auth } from "../routes/auth.js";
import { MonitorError, REVIEW_ACTIONS, type MonitorService } from "./service.js";

const IngestBody = z.object({
  event: z.unknown(),
  trace_id: z.string().max(200).nullable().optional(),
});
const DeadLetterBody = z.object({
  reason: z.string().min(1).max(200),
  error: z.string().max(4000).nullable().optional(),
  payload: z.unknown().optional(),
  event_id: z.string().max(200).nullable().optional(),
  trace_id: z.string().max(200).nullable().optional(),
});
const AlertBody = z.object({
  status: z.enum(["sent", "failed"]),
  error: z.string().max(1000).nullable().optional(),
});
const ReviewBody = z.object({
  action: z.enum(REVIEW_ACTIONS),
  reviewer: z.string().trim().min(2, "reviewer name is required").max(80),
  notes: z.string().trim().max(2000).nullable().optional(),
  channel: z.enum(["dashboard", "slack", "api"]).optional(),
});
const CaseQuery = z.object({
  status: z.string().max(40).optional(),
  severity: z.string().max(20).optional(),
  match_id: z.string().max(100).optional(),
  player_id: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const CaseParams = z.object({ id: z.string().regex(/^CASE-[A-Z0-9]{6}$/, "not a case ID") });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new RequestValidationError(`Invalid ${what}`, formatZodIssues(r.error));
  return r.data;
}

/**
 * Monitor API. n8n writes with the ingest key; the dashboard reads the public views; review
 * decisions need the control key (dashboard) or the ingest key (Slack buttons relayed by n8n).
 */
export function registerMonitorRoutes(
  app: FastifyInstance,
  deps: { monitor: MonitorService | null; auth: Auth },
): void {
  const { auth } = deps;
  const m = (): MonitorService => {
    if (!deps.monitor || !deps.monitor.isReady) {
      throw new MonitorError(
        503,
        "monitor_unavailable",
        "The monitor database is not connected yet.",
      );
    }
    return deps.monitor;
  };
  const P = "/api/v1/monitor";

  // ---- n8n writes ----------------------------------------------------------
  app.post(`${P}/events`, { preHandler: auth.ingest }, async (req, reply) => {
    const body = parse(IngestBody, req.body, "ingest request");
    const event = SimulatorEventSchema.safeParse(body.event);
    if (!event.success) {
      throw new RequestValidationError(
        "Event does not match the v1 contract",
        formatZodIssues(event.error),
      );
    }
    const result = await m().ingest(event.data, body.trace_id ?? null);
    return reply.code(result.stored ? 201 : 200).send(result);
  });

  app.post(`${P}/dead-letters`, { preHandler: auth.ingest }, async (req, reply) =>
    reply.code(201).send(await m().addDeadLetter(parse(DeadLetterBody, req.body, "dead letter"))),
  );

  app.post<{ Params: { id: string } }>(
    `${P}/cases/:id/summary`,
    { preHandler: auth.ingest },
    async (req) => {
      const { id } = parse(CaseParams, req.params, "case ID");
      return m().summarize(id);
    },
  );

  app.post<{ Params: { id: string } }>(
    `${P}/cases/:id/alert`,
    { preHandler: auth.ingest },
    async (req) => {
      const { id } = parse(CaseParams, req.params, "case ID");
      return m().recordAlert(id, parse(AlertBody, req.body, "alert result"));
    },
  );

  // ---- Human review ---------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    `${P}/cases/:id/review`,
    { preHandler: auth.ingest },
    async (req) => {
      const { id } = parse(CaseParams, req.params, "case ID");
      const body = parse(ReviewBody, req.body, "review");
      const role = auth.roleOf(req);
      const channel = role === "ingest" ? (body.channel ?? "slack") : (body.channel ?? "dashboard");
      return m().review(id, {
        action: body.action,
        reviewer: body.reviewer,
        notes: body.notes ?? null,
        channel,
      });
    },
  );

  // ---- Admin ----------------------------------------------------------------
  app.post(`${P}/reset`, { preHandler: auth.admin }, async () => m().reset("control-key"));

  app.put(`${P}/settings`, { preHandler: auth.admin }, async (req) => {
    try {
      return { thresholds: await m().updateThresholds(req.body) };
    } catch (err) {
      if (err instanceof z.ZodError)
        throw new RequestValidationError("Invalid thresholds", formatZodIssues(err));
      throw err;
    }
  });

  // ---- Public reads (dashboard) ---------------------------------------------
  app.get(`${P}/overview`, async () => m().overview());
  app.get(`${P}/cases`, async (req) => ({
    cases: await m().listCases(parse(CaseQuery, req.query, "filters")),
  }));
  app.get<{ Params: { id: string } }>(`${P}/cases/:id`, async (req) =>
    m().caseDetail(parse(CaseParams, req.params, "case ID").id),
  );
  app.get<{ Params: { id: string } }>(`${P}/cases/:id/evidence`, async (req) =>
    m().evidencePacket(parse(CaseParams, req.params, "case ID").id),
  );
  app.get(`${P}/players`, async () => m().playerRisk());
  app.get<{ Querystring: { limit?: string } }>(`${P}/dead-letters`, async (req) => ({
    dead_letters: await m().deadLetters(Number(req.query.limit) || 50),
  }));
  app.get<{ Querystring: { limit?: string } }>(`${P}/events/recent`, async (req) => ({
    events: await m().recentEvents(Number(req.query.limit) || 50),
  }));
  app.get(`${P}/settings`, async () => ({ thresholds: await m().getThresholds() }));
}
