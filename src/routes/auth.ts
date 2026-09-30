import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { type AppConfig, usableControlKey, usableTeamKey } from "../config.js";

export type Role = "admin" | "team" | "ingest";

const digest = (value: string) => createHash("sha256").update(value).digest();
const matches = (provided: Buffer, expected: Buffer | null) =>
  expected !== null && timingSafeEqual(provided, expected);

function presentedKey(req: FastifyRequest): string | null {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

export interface Auth {
  /** CONTROL_API_KEY only: runs, test events, everything. */
  admin: preHandlerHookHandler;
  /** CONTROL_API_KEY or TEAM_ACCESS_KEY: webhook management. */
  team: preHandlerHookHandler;
  /** CONTROL_API_KEY or MONITOR_INGEST_KEY: n8n writing to the monitor. */
  ingest: preHandlerHookHandler;
  /** The role for a request, "invalid" for a wrong key, or null when no key was sent. */
  roleOf(req: FastifyRequest): Role | "invalid" | null;
  /** True in development when no control key is configured, so everything is open. */
  open: boolean;
}

/**
 * Keys are sent as `X-API-Key: <key>` or `Authorization: Bearer <key>`. Without a control
 * key, production refuses protected calls and development allows them (with a warning).
 */
export function createAuth(config: AppConfig): Auth {
  const adminKey = usableControlKey(config);
  const teamKey = usableTeamKey(config);
  const adminDigest = adminKey ? digest(adminKey) : null;
  const teamDigest = teamKey ? digest(teamKey) : null;
  const ingestDigest = config.monitorIngestKey ? digest(config.monitorIngestKey) : null;
  const open = !adminDigest && config.nodeEnv !== "production";

  const roleOf = (req: FastifyRequest): Role | "invalid" | null => {
    const provided = presentedKey(req);
    if (!provided) return open ? "admin" : null;
    const d = digest(provided);
    if (matches(d, adminDigest)) return "admin";
    if (matches(d, teamDigest)) return "team";
    if (matches(d, ingestDigest)) return "ingest";
    return open ? "admin" : "invalid";
  };

  const guard = (allowed: Role[]) =>
    async function (req: FastifyRequest, reply: FastifyReply) {
      if (!adminDigest && config.nodeEnv === "production") {
        return reply.code(503).send({
          error: "control_api_not_configured",
          message: "CONTROL_API_KEY is not configured on the server.",
        });
      }
      const role = roleOf(req);
      if (role === "admin" || (role && role !== "invalid" && allowed.includes(role))) return;
      if (role === "team" || role === "ingest") {
        return reply.code(403).send({
          error: "forbidden",
          message:
            role === "team"
              ? "The team key can manage webhooks only. Use the control key for runs."
              : "The ingest key can only write monitor data.",
        });
      }
      return reply.code(401).send({
        error: "unauthorized",
        message:
          role === "invalid"
            ? "Invalid API key."
            : "Missing API key. Send it as X-API-Key or Authorization: Bearer.",
      });
    };

  return {
    admin: guard(["admin"]),
    team: guard(["admin", "team"]),
    ingest: guard(["admin", "ingest"]),
    roleOf,
    open,
  };
}
