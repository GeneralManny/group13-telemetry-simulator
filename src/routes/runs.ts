import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import {
  RequestValidationError,
  TestEventRequestSchema,
  formatZodIssues,
  resolveRunConfig,
} from "../contracts/validation.js";
import type { SimulatorEngine } from "../simulator/engine.js";
import type { Auth } from "./auth.js";

interface RunParams {
  runId: string;
}

export function registerRunRoutes(
  app: FastifyInstance,
  deps: { config: AppConfig; engine: SimulatorEngine; auth: Auth },
): void {
  const { engine, config } = deps;
  const guarded = { preHandler: deps.auth.admin };
  const defaults = {
    event_rate_per_second: config.defaultEventRate,
    duration_seconds: config.defaultMatchDurationSeconds,
  };

  app.post("/api/v1/runs", guarded, async (req, reply) => {
    const runConfig = resolveRunConfig(req.body, defaults);
    const summary = engine.start(runConfig);
    return reply.code(201).send({ ...summary, config: runConfig });
  });

  app.get<{ Params: RunParams }>("/api/v1/runs/:runId", guarded, async (req) =>
    engine.runDetails(req.params.runId),
  );

  app.post<{ Params: RunParams }>("/api/v1/runs/:runId/pause", guarded, async (req) =>
    engine.pause(req.params.runId),
  );

  app.post<{ Params: RunParams }>("/api/v1/runs/:runId/resume", guarded, async (req) =>
    engine.resume(req.params.runId),
  );

  app.post<{ Params: RunParams }>("/api/v1/runs/:runId/stop", guarded, async (req) =>
    engine.stop(req.params.runId),
  );

  app.post<{ Params: RunParams }>("/api/v1/runs/:runId/reset", guarded, async (req) =>
    engine.reset(req.params.runId),
  );

  app.post<{ Params: RunParams }>("/api/v1/runs/:runId/replay", guarded, async (req, reply) =>
    reply.code(201).send(engine.replay(req.params.runId)),
  );

  app.post("/api/v1/test-event", guarded, async (req) => {
    const parsed = TestEventRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new RequestValidationError("Invalid test event request", formatZodIssues(parsed.error));
    }
    return engine.sendTestEvent(parsed.data);
  });
}
