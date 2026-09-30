import { z } from "zod";
import { DEFAULT_OPENROUTER_MODELS } from "./monitor/ai.js";

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: "development" | "production" | "test";
  logLevel: string;
  webhookUrl: string | null;
  webhookToken: string | null;
  controlApiKey: string | null;
  /** Grants webhook management only. Teams use it to register their own n8n URLs. */
  teamAccessKey: string | null;
  /** Directory for persistent state (the webhook list). Mount a volume here in production. */
  dataDir: string | null;
  maxWebhooks: number;
  /** Postgres for the monitor. Without it the monitor endpoints answer 503. */
  databaseUrl: string | null;
  /** Key n8n uses to write to the monitor (events, summaries, alerts, Slack reviews). */
  monitorIngestKey: string | null;
  /** OpenRouter key for AI evidence summaries (free models). */
  openRouterApiKey: string | null;
  /** OpenRouter models tried in order. */
  openRouterModels: string[];
  /** Public https address of this service, used for case links in alerts. */
  publicBaseUrl: string | null;
  defaultEventRate: number;
  defaultMatchDurationSeconds: number;
  deliveryTimeoutMs: number;
  maxDeliveryAttempts: number;
  maxQueueSize: number;
  deliveryConcurrency: number;
  retryDelaysMs: number[];
  allowedOrigins: string[];
  /** Names of variables that were set but invalid. Values are never recorded. */
  invalidVariables: string[];
}

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

const EnvSchema = z.object({
  PORT: opt(z.coerce.number().int().min(1).max(65535)),
  HOST: opt(z.string()),
  NODE_ENV: opt(z.enum(["development", "production", "test"])),
  LOG_LEVEL: opt(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])),
  N8N_WEBHOOK_URL: opt(z.url({ protocol: /^https?$/ })),
  N8N_WEBHOOK_TOKEN: opt(z.string().min(1)),
  CONTROL_API_KEY: opt(z.string().min(1)),
  TEAM_ACCESS_KEY: opt(z.string().min(1)),
  DATA_DIR: opt(z.string().min(1)),
  MAX_WEBHOOKS: opt(z.coerce.number().int().min(1).max(100)),
  DATABASE_URL: opt(z.string().regex(/^postgres(ql)?:\/\//)),
  MONITOR_INGEST_KEY: opt(z.string().min(16)),
  OPENROUTER_API_KEY: opt(z.string().min(1)),
  OPENROUTER_MODELS: opt(z.string().regex(/^[\w./:-]+(,[\w./:-]+)*$/)),
  PUBLIC_BASE_URL: opt(z.url({ protocol: /^https?$/ })),
  DEFAULT_EVENT_RATE: opt(z.coerce.number().min(0.1).max(50)),
  DEFAULT_MATCH_DURATION_SECONDS: opt(z.coerce.number().int().min(10).max(7200)),
  DELIVERY_TIMEOUT_MS: opt(z.coerce.number().int().min(100).max(60_000)),
  MAX_DELIVERY_ATTEMPTS: opt(z.coerce.number().int().min(1).max(10)),
  MAX_QUEUE_SIZE: opt(z.coerce.number().int().min(10).max(100_000)),
  DELIVERY_CONCURRENCY: opt(z.coerce.number().int().min(1).max(32)),
  RETRY_DELAYS_MS: opt(
    z
      .string()
      .regex(/^\d+(,\d+)*$/)
      .transform((s) => s.split(",").map(Number)),
  ),
  ALLOWED_ORIGIN: opt(z.string()),
});

type Env = z.infer<typeof EnvSchema>;

/**
 * Reads configuration from the environment. Invalid values fall back to defaults and
 * are reported by name through `invalidVariables` (and therefore by /ready).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(EnvSchema.shape)) raw[key] = env[key];

  const invalid: string[] = [];
  let parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      if (!invalid.includes(key)) invalid.push(key);
      delete raw[key];
    }
    parsed = EnvSchema.safeParse(raw);
  }
  const e: Env = parsed.success ? parsed.data : {};

  return {
    port: e.PORT ?? 3000,
    host: e.HOST ?? "0.0.0.0",
    nodeEnv: e.NODE_ENV ?? "development",
    logLevel: e.LOG_LEVEL ?? "info",
    webhookUrl: e.N8N_WEBHOOK_URL ?? null,
    webhookToken: e.N8N_WEBHOOK_TOKEN ?? null,
    controlApiKey: e.CONTROL_API_KEY ?? null,
    teamAccessKey: e.TEAM_ACCESS_KEY ?? null,
    dataDir: e.DATA_DIR ?? null,
    maxWebhooks: e.MAX_WEBHOOKS ?? 20,
    databaseUrl: e.DATABASE_URL ?? null,
    monitorIngestKey: e.MONITOR_INGEST_KEY ?? null,
    openRouterApiKey: e.OPENROUTER_API_KEY ?? null,
    openRouterModels: e.OPENROUTER_MODELS
      ? e.OPENROUTER_MODELS.split(",")
          .map((m) => m.trim())
          .filter(Boolean)
      : DEFAULT_OPENROUTER_MODELS,
    publicBaseUrl: e.PUBLIC_BASE_URL ? e.PUBLIC_BASE_URL.replace(/\/$/, "") : null,
    defaultEventRate: e.DEFAULT_EVENT_RATE ?? 2,
    defaultMatchDurationSeconds: e.DEFAULT_MATCH_DURATION_SECONDS ?? 300,
    deliveryTimeoutMs: e.DELIVERY_TIMEOUT_MS ?? 5000,
    maxDeliveryAttempts: e.MAX_DELIVERY_ATTEMPTS ?? 4,
    maxQueueSize: e.MAX_QUEUE_SIZE ?? 1000,
    deliveryConcurrency: e.DELIVERY_CONCURRENCY ?? 4,
    retryDelaysMs: e.RETRY_DELAYS_MS ?? [1000, 3000, 10000],
    allowedOrigins: (e.ALLOWED_ORIGIN ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    invalidVariables: invalid,
  };
}

const PLACEHOLDER_VALUES = new Set(["replace-with-secret", "changeme", "change-me"]);

function isPlaceholderUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".invalid") || host === "example.com" || host.endsWith(".example");
  } catch {
    return true;
  }
}

export interface Readiness {
  ready: boolean;
  missing: string[];
  invalid: string[];
  warnings: string[];
}

/**
 * Readiness reports variable names only, never values. A production service is ready to
 * emit when it has at least one destination: N8N_WEBHOOK_URL or a dashboard webhook.
 */
export function checkReadiness(
  config: AppConfig,
  state: { enabledWebhooks: number; webhookStorePersistent: boolean } = {
    enabledWebhooks: 0,
    webhookStorePersistent: false,
  },
): Readiness {
  const production = config.nodeEnv === "production";
  const missing: string[] = [];
  const warnings: string[] = [];

  const webhookMissing = !config.webhookUrl || isPlaceholderUrl(config.webhookUrl);
  const keyMissing = !config.controlApiKey || PLACEHOLDER_VALUES.has(config.controlApiKey);

  if (webhookMissing && state.enabledWebhooks === 0) {
    if (production) missing.push("N8N_WEBHOOK_URL");
    else warnings.push("No webhook destination: add one in the dashboard or set N8N_WEBHOOK_URL");
  }
  if (production && !state.webhookStorePersistent) {
    warnings.push("DATA_DIR is not set or not writable: dashboard webhooks are lost on restart");
  }
  if (keyMissing) {
    if (production) missing.push("CONTROL_API_KEY");
    else
      warnings.push("CONTROL_API_KEY is not set: control endpoints are unprotected in development");
  }
  if (!config.webhookToken || PLACEHOLDER_VALUES.has(config.webhookToken)) {
    warnings.push(
      "N8N_WEBHOOK_TOKEN is not set: webhook requests carry no X-Simulator-Token header",
    );
  }
  if (production && config.controlApiKey && !keyMissing && config.controlApiKey.length < 16) {
    warnings.push("CONTROL_API_KEY is shorter than 16 characters");
  }

  const invalid = [...config.invalidVariables];
  return { ready: missing.length === 0 && invalid.length === 0, missing, invalid, warnings };
}

/** The default webhook URL, or null when it is missing or a placeholder. */
export function usableWebhookUrl(config: AppConfig): string | null {
  return config.webhookUrl && !isPlaceholderUrl(config.webhookUrl) ? config.webhookUrl : null;
}

/** The team access key, or null when it is missing or a placeholder. */
export function usableTeamKey(config: AppConfig): string | null {
  return config.teamAccessKey && !PLACEHOLDER_VALUES.has(config.teamAccessKey)
    ? config.teamAccessKey
    : null;
}

/** The control API key, or null when it is missing or a placeholder. */
export function usableControlKey(config: AppConfig): string | null {
  return config.controlApiKey && !PLACEHOLDER_VALUES.has(config.controlApiKey)
    ? config.controlApiKey
    : null;
}
