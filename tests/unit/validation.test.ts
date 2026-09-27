import { describe, expect, it } from "vitest";
import { checkReadiness, loadConfig } from "../../src/config.js";
import { RequestValidationError } from "../../src/contracts/validation.js";
import { PRESET_NAMES } from "../../src/scenarios/presets.js";
import { resolve } from "../helpers/index.js";

function issuesOf(body: object): string[] {
  try {
    resolve(body);
  } catch (err) {
    if (err instanceof RequestValidationError) return err.issues.map((i) => i.path);
    throw err;
  }
  return [];
}

describe("run configuration", () => {
  it.each(PRESET_NAMES)("preset %s resolves", (preset) => {
    expect(() => resolve({ preset })).not.toThrow();
  });

  it("matches the saved final demo configuration", () => {
    const c = resolve({ preset: "final_demo" });
    expect(c).toMatchObject({
      scenario: "combined",
      seed: 13027,
      event_rate_per_second: 2,
      duration_seconds: 240,
      target_player_id: "player_07",
      anomaly_start_second: 60,
      odds_anomaly_start_second: 90,
      performance_anomaly_enabled: true,
      odds_anomaly_enabled: true,
      failure_modes: null,
    });
  });

  it("lets request values override a preset", () => {
    expect(resolve({ preset: "final_demo", seed: 5 }).seed).toBe(5);
  });

  it("generates a seed when none is given and reports it", () => {
    const c = resolve({ scenario: "normal" });
    expect(Number.isInteger(c.seed)).toBe(true);
  });

  it("never enables failure modes unless requested", () => {
    for (const scenario of ["normal", "performance_anomaly", "odds_integrity", "combined"]) {
      expect(resolve({ scenario }).failure_modes).toBeNull();
    }
    expect(resolve({ scenario: "pipeline_failure" }).failure_modes).not.toBeNull();
    expect(
      resolve({ scenario: "normal", failure_modes: { duplicate: true } }).failure_modes,
    ).toMatchObject({
      duplicate: true,
      malformed: false,
    });
  });

  it("rejects an unknown scenario", () => {
    expect(issuesOf({ scenario: "cheating" })).toContain("scenario");
  });

  it("rejects a missing scenario and preset", () => {
    expect(issuesOf({ seed: 1 })).toContain("scenario");
  });

  it("rejects unknown fields to catch typos", () => {
    expect(issuesOf({ scenario: "normal", sead: 1 })).toContain("(body)");
  });

  it("rejects an unknown player", () => {
    expect(issuesOf({ scenario: "performance_anomaly", target_player_id: "player_99" })).toContain(
      "target_player_id",
    );
  });

  it("rejects an anomaly that starts after the match ends", () => {
    expect(
      issuesOf({ scenario: "performance_anomaly", duration_seconds: 60, anomaly_start_second: 90 }),
    ).toContain("anomaly_start_second");
    expect(
      issuesOf({ scenario: "odds_integrity", duration_seconds: 60, odds_anomaly_start_second: 60 }),
    ).toContain("odds_anomaly_start_second");
  });

  it("rejects out-of-range rates and non-http webhook URLs", () => {
    expect(issuesOf({ scenario: "normal", event_rate_per_second: 500 })).toContain(
      "event_rate_per_second",
    );
    expect(issuesOf({ scenario: "normal", webhook_url: "ftp://example.com" })).toContain(
      "webhook_url",
    );
  });
});

describe("environment configuration", () => {
  it("uses safe defaults for non-secret settings", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      port: 3000,
      host: "0.0.0.0",
      defaultEventRate: 2,
      maxDeliveryAttempts: 4,
    });
    expect(c.webhookUrl).toBeNull();
    expect(c.controlApiKey).toBeNull();
  });

  it("reports invalid variables by name and falls back to defaults", () => {
    const c = loadConfig({ PORT: "not-a-port", DEFAULT_EVENT_RATE: "fast" });
    expect(c.port).toBe(3000);
    expect(c.invalidVariables.sort()).toEqual(["DEFAULT_EVENT_RATE", "PORT"]);
  });

  it("fails readiness in production when required variables are missing", () => {
    const r = checkReadiness(loadConfig({ NODE_ENV: "production" }));
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(["N8N_WEBHOOK_URL", "CONTROL_API_KEY"]);
  });

  it("treats the .env.example placeholders as missing", () => {
    const r = checkReadiness(
      loadConfig({
        NODE_ENV: "production",
        N8N_WEBHOOK_URL: "https://example.invalid/webhook/telemetry",
        CONTROL_API_KEY: "replace-with-secret",
      }),
    );
    expect(r.missing).toEqual(["N8N_WEBHOOK_URL", "CONTROL_API_KEY"]);
  });

  it("is ready in production with the required variables", () => {
    const r = checkReadiness(
      loadConfig({
        NODE_ENV: "production",
        N8N_WEBHOOK_URL: "https://n8n.group13.app/webhook/telemetry",
        CONTROL_API_KEY: "a-long-enough-secret-key",
        N8N_WEBHOOK_TOKEN: "token",
      }),
      { enabledWebhooks: 0, webhookStorePersistent: true },
    );
    expect(r).toEqual({ ready: true, missing: [], invalid: [], warnings: [] });
  });

  it("is ready in production with a dashboard webhook instead of N8N_WEBHOOK_URL", () => {
    const r = checkReadiness(
      loadConfig({ NODE_ENV: "production", CONTROL_API_KEY: "a-long-enough-secret-key" }),
      { enabledWebhooks: 1, webhookStorePersistent: true },
    );
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("warns when dashboard webhooks would not survive a restart", () => {
    const r = checkReadiness(
      loadConfig({ NODE_ENV: "production", CONTROL_API_KEY: "a-long-enough-secret-key" }),
      { enabledWebhooks: 1, webhookStorePersistent: false },
    );
    expect(r.warnings.join(" ")).toContain("DATA_DIR");
  });

  it("never includes secret values in readiness output", () => {
    const secret = "super-secret-value-123456";
    const r = checkReadiness(loadConfig({ NODE_ENV: "production", CONTROL_API_KEY: secret }));
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});
