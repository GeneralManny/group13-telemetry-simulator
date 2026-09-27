import type { FastifyInstance } from "fastify";
import { type AppConfig, checkReadiness } from "../config.js";
import { SCHEMA_VERSION } from "../contracts/events.js";
import { SERVICE_NAME, SIMULATOR_VERSION } from "../simulator/ids.js";
import type { SimulatorEngine } from "../simulator/engine.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { config: AppConfig; engine: SimulatorEngine },
): void {
  const startedAt = Date.now();

  // Must stay fast and must not depend on n8n being reachable.
  app.get("/health", async () => ({
    status: "ok",
    service: SERVICE_NAME,
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    time: new Date().toISOString(),
  }));

  app.get("/ready", async (_req, reply) => {
    const r = checkReadiness(deps.config);
    return reply.code(r.ready ? 200 : 503).send({
      status: r.ready ? "ready" : "not_ready",
      environment: deps.config.nodeEnv,
      engine_state: deps.engine.state,
      missing_variables: r.missing,
      invalid_variables: r.invalid,
      warnings: r.warnings,
    });
  });

  app.get("/", async () => ({
    service: SERVICE_NAME,
    version: SIMULATOR_VERSION,
    schema_version: SCHEMA_VERSION,
    endpoints: {
      public: [
        "GET /health",
        "GET /ready",
        "GET /api/v1/status",
        "GET /api/v1/scenarios",
        "GET /api/v1/players",
        "GET /api/v1/events/recent",
        "GET /api/v1/events/stream",
      ],
      protected: [
        "POST /api/v1/runs",
        "GET /api/v1/runs/:runId",
        "POST /api/v1/runs/:runId/pause",
        "POST /api/v1/runs/:runId/resume",
        "POST /api/v1/runs/:runId/stop",
        "POST /api/v1/runs/:runId/reset",
        "POST /api/v1/runs/:runId/replay",
        "POST /api/v1/test-event",
      ],
    },
    notes: "Protected endpoints need X-API-Key. :runId may be 'current'.",
  }));
}
