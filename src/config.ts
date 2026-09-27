import { z } from "zod";

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: "development" | "production" | "test";
  logLevel: string;
  webhookUrl: string | null;
  webhookToken: string | null;
  controlApiKey: string | null;
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

/** Readiness reports variable names only, never values. */
export function checkReadiness(config: AppConfig): Readiness {
  const production = config.nodeEnv === "production";
  const missing: string[] = [];
  const warnings: string[] = [];

  const webhookMissing = !config.webhookUrl || isPlaceholderUrl(config.webhookUrl);
  const keyMissing = !config.controlApiKey || PLACEHOLDER_VALUES.has(config.controlApiKey);

  if (webhookMissing) {
    if (production) missing.push("N8N_WEBHOOK_URL");
    else warnings.push("N8N_WEBHOOK_URL is not set: runs default to dry-run (no delivery)");
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

/** The control API key, or null when it is missing or a placeholder. */
export function usableControlKey(config: AppConfig): string | null {
  return config.controlApiKey && !PLACEHOLDER_VALUES.has(config.controlApiKey)
    ? config.controlApiKey
    : null;
}
