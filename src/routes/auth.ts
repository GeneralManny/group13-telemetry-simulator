import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type AppConfig, usableControlKey } from "../config.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

function presentedKey(req: FastifyRequest): string | null {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

/**
 * Protects control endpoints with CONTROL_API_KEY, sent as `X-API-Key: <key>` or
 * `Authorization: Bearer <key>`. Without a key, production refuses all control calls
 * and development allows them (with a warning at startup).
 */
export function createControlAuth(config: AppConfig) {
  const key = usableControlKey(config);
  const expected = key ? digest(key) : null;

  return async function controlAuth(req: FastifyRequest, reply: FastifyReply) {
    if (!expected) {
      if (config.nodeEnv === "production") {
        return reply.code(503).send({
          error: "control_api_not_configured",
          message: "CONTROL_API_KEY is not configured on the server.",
        });
      }
      return;
    }
    const provided = presentedKey(req);
    if (!provided || !timingSafeEqual(digest(provided), expected)) {
      return reply.code(401).send({
        error: "unauthorized",
        message: provided
          ? "Invalid API key."
          : "Missing API key. Send it as X-API-Key or Authorization: Bearer.",
      });
    }
  };
}
