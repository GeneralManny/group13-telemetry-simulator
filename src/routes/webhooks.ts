import type { FastifyInstance } from "fastify";
import {
  RequestValidationError,
  TestEventRequestSchema,
  formatZodIssues,
} from "../contracts/validation.js";
import {
  CreateSubscriptionSchema,
  UpdateSubscriptionSchema,
  type SubscriptionStore,
} from "../delivery/subscriptions.js";
import type { SimulatorEngine } from "../simulator/engine.js";
import type { Auth } from "./auth.js";

interface IdParams {
  id: string;
}

/**
 * Teams register their own n8n webhook URLs here (team or control key). Every emitted
 * event is delivered to each enabled webhook, starting with the next event.
 */
export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: { engine: SimulatorEngine; subscriptions: SubscriptionStore; auth: Auth },
): void {
  const { engine, subscriptions } = deps;
  const guarded = { preHandler: deps.auth.team };

  app.get("/api/v1/session", async (req, reply) => {
    const role = deps.auth.roleOf(req);
    if (role === "invalid") {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid API key." });
    }
    return {
      role,
      open: deps.auth.open,
      can_control_runs: role === "admin",
      can_manage_webhooks: role === "admin" || role === "team",
      can_review_cases: role === "admin",
    };
  });

  app.get("/api/v1/webhooks", guarded, async () => ({
    destinations: engine.destinations(),
    persistent: subscriptions.persistent,
    persist_error: subscriptions.lastPersistError,
  }));

  app.post("/api/v1/webhooks", guarded, async (req, reply) => {
    const parsed = CreateSubscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new RequestValidationError("Invalid webhook", formatZodIssues(parsed.error));
    }
    return reply.code(201).send(subscriptions.create(parsed.data));
  });

  app.patch<{ Params: IdParams }>("/api/v1/webhooks/:id", guarded, async (req) => {
    const parsed = UpdateSubscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new RequestValidationError("Invalid webhook update", formatZodIssues(parsed.error));
    }
    return subscriptions.update(req.params.id, parsed.data);
  });

  app.delete<{ Params: IdParams }>("/api/v1/webhooks/:id", guarded, async (req, reply) => {
    subscriptions.remove(req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: IdParams }>("/api/v1/webhooks/:id/test", guarded, async (req) => {
    const target = engine.destinationTarget(req.params.id);
    const parsed = TestEventRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new RequestValidationError("Invalid test event request", formatZodIssues(parsed.error));
    }
    const result = await engine.sendTestEvent(parsed.data, target);
    return { event: result.event, delivery: result.delivery };
  });
}
