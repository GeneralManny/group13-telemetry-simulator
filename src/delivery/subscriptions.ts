import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isIP } from "node:net";
import type { Logger } from "pino";
import { z } from "zod";
import { EVENT_TYPES, type EventType } from "../contracts/events.js";
import type { WebhookTarget } from "./webhook-client.js";

/**
 * A webhook destination a team registered from the dashboard. Every emitted event is
 * delivered to each enabled subscription (optionally filtered by event type), in addition
 * to the N8N_WEBHOOK_URL from the environment.
 */
export interface Subscription {
  id: string;
  name: string;
  url: string;
  token: string | null;
  /** null means every event type. */
  event_types: EventType[] | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** What the API returns. The token is never sent back; the URL path is shortened. */
export interface PublicSubscription extends Omit<Subscription, "token" | "url"> {
  url_display: string;
  host: string;
  token_set: boolean;
}

export class SubscriptionError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".railway.internal"];

/** Rejects addresses that would let the simulator be pointed at private infrastructure. */
const LOCAL_ADDRESS =
  "points to your own computer, which the simulator on Railway cannot reach. Give n8n a " +
  "public https address (n8n Cloud, a hosted n8n, or a tunnel such as " +
  "`cloudflared tunnel --url http://localhost:5678`) and paste that address instead";
const PRIVATE_ADDRESS =
  "is a private network address the simulator cannot reach. Use a public https address";
const NEEDS_HTTPS =
  "must use https. A tunnel such as Cloudflare Tunnel or ngrok gives n8n an https address";

/**
 * Rejects addresses the hosted simulator cannot or must not call. Local and private
 * addresses are checked first so the message explains the real problem, not just https.
 */
export function checkDestinationUrl(raw: string, production: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be a valid URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "must use http or https";
  if (url.username || url.password) return "must not contain a username or password";
  if (!production) return null;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".localhost")) {
    return LOCAL_ADDRESS;
  }
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return PRIVATE_ADDRESS;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 127 || a === 0) return LOCAL_ADDRESS;
    const privateV4 =
      a === 10 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
    if (privateV4) return PRIVATE_ADDRESS;
  }
  if (ipVersion === 6) {
    if (host === "::1") return LOCAL_ADDRESS;
    if (/^(fc|fd|fe8|fe9|fea|feb)/.test(host)) return PRIVATE_ADDRESS;
  }
  if (url.protocol !== "https:") return NEEDS_HTTPS;
  return null;
}

export function displayUrl(raw: string): { host: string; url_display: string } {
  try {
    // Only the first path segment is shown: n8n webhook paths are effectively secrets.
    const u = new URL(raw);
    const [first, ...rest] = u.pathname.split("/").filter(Boolean);
    const path = first ? `/${first}${rest.length ? "/…" : ""}` : "";
    return { host: u.host, url_display: `${u.protocol}//${u.host}${path}` };
  } catch {
    return { host: "invalid", url_display: "invalid" };
  }
}

const nameField = z.string().trim().min(1, "is required").max(60);
const tokenField = z
  .string()
  .max(200)
  .transform((s) => s.trim() || null)
  .nullable();
const eventTypesField = z
  .array(z.enum(EVENT_TYPES))
  .max(EVENT_TYPES.length)
  .transform((list) =>
    list.length === 0 || list.length === EVENT_TYPES.length ? null : [...new Set(list)],
  )
  .nullable();

export const CreateSubscriptionSchema = z
  .object({
    name: nameField,
    url: z.string().trim().min(1, "is required").max(2000),
    token: tokenField.optional(),
    event_types: eventTypesField.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const UpdateSubscriptionSchema = z
  .object({
    name: nameField.optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    token: tokenField.optional(),
    event_types: eventTypesField.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export interface SubscriptionStoreOptions {
  /** JSON file to persist to. null keeps subscriptions in memory only. */
  filePath: string | null;
  logger: Logger;
  maxSubscriptions: number;
  production: boolean;
}

export class SubscriptionStore {
  private items: Subscription[] = [];
  private persistError: string | null = null;

  constructor(private readonly opts: SubscriptionStoreOptions) {
    this.load();
  }

  get persistent(): boolean {
    return this.opts.filePath !== null && this.persistError === null;
  }

  get lastPersistError(): string | null {
    return this.persistError;
  }

  get count(): number {
    return this.items.length;
  }

  get enabledCount(): number {
    return this.items.filter((s) => s.enabled).length;
  }

  list(): PublicSubscription[] {
    return this.items.map(toPublic);
  }

  get(id: string): Subscription {
    const item = this.items.find((s) => s.id === id);
    if (!item) throw new SubscriptionError(404, "webhook_not_found", `No webhook with id ${id}.`);
    return item;
  }

  create(input: z.infer<typeof CreateSubscriptionSchema>): PublicSubscription {
    if (this.items.length >= this.opts.maxSubscriptions) {
      throw new SubscriptionError(
        409,
        "webhook_limit",
        `At most ${this.opts.maxSubscriptions} webhooks can be registered.`,
      );
    }
    this.assertUrl(input.url);
    if (this.items.some((s) => s.url === input.url)) {
      throw new SubscriptionError(409, "webhook_exists", "That URL is already registered.");
    }
    const now = new Date().toISOString();
    const item: Subscription = {
      id: `wh_${randomBytes(4).toString("hex")}`,
      name: input.name,
      url: input.url,
      token: input.token ?? null,
      event_types: input.event_types ?? null,
      enabled: input.enabled ?? true,
      created_at: now,
      updated_at: now,
    };
    this.items.push(item);
    this.save();
    this.opts.logger.info(
      { webhook_id: item.id, name: item.name, host: displayUrl(item.url).host },
      "webhook registered",
    );
    return toPublic(item);
  }

  update(id: string, patch: z.infer<typeof UpdateSubscriptionSchema>): PublicSubscription {
    const item = this.get(id);
    if (patch.url !== undefined) {
      this.assertUrl(patch.url);
      if (this.items.some((s) => s.id !== id && s.url === patch.url)) {
        throw new SubscriptionError(409, "webhook_exists", "That URL is already registered.");
      }
      item.url = patch.url;
    }
    if (patch.name !== undefined) item.name = patch.name;
    if (patch.token !== undefined) item.token = patch.token;
    if (patch.event_types !== undefined) item.event_types = patch.event_types;
    if (patch.enabled !== undefined) item.enabled = patch.enabled;
    item.updated_at = new Date().toISOString();
    this.save();
    this.opts.logger.info({ webhook_id: id, enabled: item.enabled }, "webhook updated");
    return toPublic(item);
  }

  remove(id: string): void {
    this.get(id);
    this.items = this.items.filter((s) => s.id !== id);
    this.save();
    this.opts.logger.info({ webhook_id: id }, "webhook removed");
  }

  /** Delivery targets for one event type. */
  targetsFor(eventType: string): WebhookTarget[] {
    return this.items
      .filter(
        (s) => s.enabled && (!s.event_types || s.event_types.includes(eventType as EventType)),
      )
      .map((s) => targetOf(s));
  }

  target(id: string): WebhookTarget {
    return targetOf(this.get(id));
  }

  private assertUrl(url: string): void {
    const problem = checkDestinationUrl(url, this.opts.production);
    if (problem) {
      throw new SubscriptionError(400, "invalid_webhook_url", `Webhook URL ${problem}.`);
    }
  }

  private load(): void {
    const path = this.opts.filePath;
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { subscriptions?: Subscription[] };
      this.items = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      this.opts.logger.info({ count: this.items.length }, "webhooks loaded from disk");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.opts.logger.error({ err, path }, "could not read webhook store, starting empty");
      }
    }
  }

  private save(): void {
    const path = this.opts.filePath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, subscriptions: this.items }, null, 2));
      renameSync(tmp, path);
      this.persistError = null;
    } catch (err) {
      this.persistError = (err as NodeJS.ErrnoException).code ?? "write_failed";
      this.opts.logger.error({ err, path }, "could not save webhook store; changes kept in memory");
    }
  }
}

function targetOf(s: Subscription): WebhookTarget {
  return { id: s.id, name: s.name, url: s.url, token: s.token };
}

function toPublic(s: Subscription): PublicSubscription {
  const { token, url, ...rest } = s;
  return { ...rest, ...displayUrl(url), token_set: token !== null };
}
