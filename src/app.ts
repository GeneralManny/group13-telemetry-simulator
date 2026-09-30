import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { pino, type Logger } from "pino";
import type { AppConfig } from "./config.js";
import { RequestValidationError } from "./contracts/validation.js";
import { DeliveryQueue } from "./delivery/retry-queue.js";
import { SubscriptionError, SubscriptionStore } from "./delivery/subscriptions.js";
import { createWebhookSender, type Sender } from "./delivery/webhook-client.js";
import { createAuth } from "./routes/auth.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { createPool } from "./monitor/db/database.js";
import { registerMonitorRoutes } from "./monitor/routes.js";
import { MonitorError, MonitorService } from "./monitor/service.js";
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
  subscriptions: SubscriptionStore;
  monitor: MonitorService | null;
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

const QUIET_PATHS = new Set([
  "/health",
  "/ready",
  "/api/v1/status",
  "/api/v1/events/recent",
  "/api/v1/timeline",
  "/api/v1/session",
  "/api/v1/webhooks",
]);

/** The Next.js static export, built from dashboard/ (npm run build:dashboard). */
const DASHBOARD_DIR = join(import.meta.dirname, "..", "dashboard", "out");

/**
 * The dashboard only loads its own files and calls its own API. Next.js inlines a few
 * bootstrap scripts, so those are allowed by hash rather than with 'unsafe-inline'.
 * Inline style attributes (chart widths, colours) are allowed.
 */
function contentSecurityPolicy(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

function inlineScriptHashes(dir: string): string[] {
  const hashes = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
    const html = readFileSync(join(dir, file), "utf8");
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      if (m[1]) hashes.add(`'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
    }
  }
  return [...hashes];
}

const FALLBACK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Simulator</title></head>
<body style="font-family:system-ui;padding:32px;background:#f6f6f3;color:#0b0b0b">
<h1>Group 13 simulator</h1><p>The API is running. The dashboard has not been built:
run <code>npm run build:dashboard</code>. API index: <a href="/api">/api</a>.</p></body></html>`;

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
  const subscriptions = new SubscriptionStore({
    filePath: config.dataDir ? join(config.dataDir, "webhooks.json") : null,
    logger: logger.child({ component: "webhooks" }),
    maxSubscriptions: config.maxWebhooks,
    production: config.nodeEnv === "production",
  });
  const engine = new SimulatorEngine({
    config,
    delivery,
    subscriptions,
    logger: logger.child({ component: "engine" }),
    tickIntervalMs: deps.tickIntervalMs,
  });

  // The monitor connects in the background with retries, so /health answers immediately and a
  // slow or restarting database never blocks the simulator.
  const monitor = config.databaseUrl
    ? new MonitorService(createPool(config.databaseUrl), logger.child({ component: "monitor" }), {
        ai: {
          apiKey: config.openRouterApiKey,
          models: config.openRouterModels,
          appUrl: config.publicBaseUrl,
        },
        publicBaseUrl: config.publicBaseUrl,
      })
    : null;
  let monitorTimer: NodeJS.Timeout | null = null;
  const startMonitor = async (attempt = 1): Promise<void> => {
    if (!monitor) return;
    try {
      await monitor.init();
      logger.info({ attempt }, "monitor ready");
    } catch (err) {
      const wait = Math.min(30_000, 2000 * attempt);
      logger.error({ err, attempt, retry_in_ms: wait }, "monitor database not ready, retrying");
      monitorTimer = setTimeout(() => void startMonitor(attempt + 1), wait);
      monitorTimer.unref();
    }
  };
  void startMonitor();

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
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "x-api-key", "authorization"],
  });

  const dashboardBuilt = existsSync(join(DASHBOARD_DIR, "index.html"));
  const csp = contentSecurityPolicy(dashboardBuilt ? inlineScriptHashes(DASHBOARD_DIR) : []);

  app.addHook("onSend", async (_req, reply) => {
    reply.header("content-security-policy", csp);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
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
    if (error instanceof MonitorError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof SubscriptionError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
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

  const auth = createAuth(config);
  registerHealthRoutes(app, { config, engine, subscriptions, monitor });
  registerStatusRoutes(app, { engine });
  registerRunRoutes(app, { config, engine, auth });
  registerEventRoutes(app, { config, engine });
  registerWebhookRoutes(app, { engine, subscriptions, auth });
  registerMonitorRoutes(app, { monitor, auth });

  app.addHook("onClose", async () => {
    if (monitorTimer) clearTimeout(monitorTimer);
    await monitor?.pool.end().catch(() => undefined);
  });

  // Dashboard. Files are registered individually (no wildcard) so unknown paths still 404 as JSON.
  if (dashboardBuilt) {
    await app.register(fastifyStatic, {
      root: DASHBOARD_DIR,
      prefix: "/",
      wildcard: false,
      index: ["index.html"],
      cacheControl: false,
      setHeaders: (res, path) =>
        res.header(
          "cache-control",
          path.includes("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache",
        ),
    });
  } else {
    logger.warn("dashboard not built; serving a placeholder page at /");
    app.get("/", async (_req, reply) => reply.type("text/html").send(FALLBACK_PAGE));
  }

  return { app, engine, delivery, subscriptions, monitor };
}
