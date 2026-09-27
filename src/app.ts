import cors from "@fastify/cors";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { pino, type Logger } from "pino";
import type { AppConfig } from "./config.js";
import { RequestValidationError } from "./contracts/validation.js";
import { DeliveryQueue } from "./delivery/retry-queue.js";
import { createWebhookSender, type Sender } from "./delivery/webhook-client.js";
import { createControlAuth } from "./routes/auth.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerStatusRoutes } from "./routes/status.js";
import { EngineError, SimulatorEngine } from "./simulator/engine.js";

export interface AppDeps {
  config: AppConfig;
  logger?: Logger;
  /** Replaces the HTTP sender. Tests use this to simulate n8n responses. */
  sender?: Sender;
  tickIntervalMs?: number;
}

export interface BuiltApp {
  app: FastifyInstance;
  engine: SimulatorEngine;
  delivery: DeliveryQueue;
}

/** Headers that must never reach the logs. */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  'req.headers["x-simulator-token"]',
  "headers.authorization",
  'headers["x-api-key"]',
  'headers["x-simulator-token"]',
];

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.logLevel,
    base: { service: "group13-telemetry-simulator" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
  });
}

const QUIET_PATHS = new Set(["/health", "/ready", "/api/v1/status", "/api/v1/events/recent"]);

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config } = deps;
  const logger = deps.logger ?? createLogger(config);

  const delivery = new DeliveryQueue({
    sender: deps.sender ?? createWebhookSender({ timeoutMs: config.deliveryTimeoutMs }),
    logger: logger.child({ component: "delivery" }),
    maxQueueSize: config.maxQueueSize,
    maxAttempts: config.maxDeliveryAttempts,
    retryDelaysMs: config.retryDelaysMs,
    concurrency: config.deliveryConcurrency,
  });
  const engine = new SimulatorEngine({
    config,
    delivery,
    logger: logger.child({ component: "engine" }),
    tickIntervalMs: deps.tickIntervalMs,
  });

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // Fastify's own per-request lines are replaced by the quieter onResponse hook below.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
  });

  // Accept an empty body on JSON POSTs, so `curl -X POST -H 'content-type: application/json'` works.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body).trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("Request body is not valid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(cors, {
    origin: config.allowedOrigins.length ? config.allowedOrigins : false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "x-api-key", "authorization"],
  });

  app.addHook("onResponse", async (req, reply) => {
    const path = req.url.split("?")[0] ?? req.url;
    const entry = {
      method: req.method,
      path,
      status_code: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
    };
    if (QUIET_PATHS.has(path)) req.log.debug(entry, "request");
    else req.log.info(entry, "request");
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof EngineError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof RequestValidationError) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: error.message, issues: error.issues });
    }
    const e = error as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: "bad_request", message: e.message });
    }
    req.log.error({ err: error }, "unhandled request error");
    return reply.code(500).send({ error: "internal_error", message: "Unexpected server error." });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: "not_found", message: `No route for ${req.method} ${req.url}` }),
  );

  const auth = createControlAuth(config);
  registerHealthRoutes(app, { config, engine });
  registerStatusRoutes(app, { engine });
  registerRunRoutes(app, { config, engine, auth });
  registerEventRoutes(app, { config, engine });

  return { app, engine, delivery };
}
