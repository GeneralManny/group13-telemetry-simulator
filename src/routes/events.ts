import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { SimulatorEngine } from "../simulator/engine.js";

const MAX_STREAM_CLIENTS = 25;
const HEARTBEAT_MS = 15_000;

/**
 * Read-only live preview for the dashboard: the most recent emitted events, and a
 * Server-Sent Events stream of new ones. Delivery to n8n does not depend on these.
 */
export function registerEventRoutes(
  app: FastifyInstance,
  deps: { config: AppConfig; engine: SimulatorEngine },
): void {
  const clients = new Set<ServerResponse>();

  app.get<{ Querystring: { limit?: string } }>("/api/v1/events/recent", async (req) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    return { events: deps.engine.recentEvents(limit) };
  });

  app.get("/api/v1/events/stream", (req, reply) => {
    if (clients.size >= MAX_STREAM_CLIENTS) {
      return reply.code(503).send({ error: "too_many_streams", message: "Stream limit reached." });
    }
    reply.hijack();
    const res = reply.raw;
    const headers: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
    const origin = req.headers.origin;
    if (origin && deps.config.allowedOrigins.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers.vary = "Origin";
    }
    res.writeHead(200, headers);
    res.write(": connected\n\n");
    clients.add(res);

    const unsubscribe = deps.engine.subscribe((e) => {
      res.write(`event: telemetry\ndata: ${JSON.stringify(e)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    heartbeat.unref();
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      clients.delete(res);
    });
  });

  app.addHook("onClose", async () => {
    for (const res of clients) res.end();
    clients.clear();
  });
}
