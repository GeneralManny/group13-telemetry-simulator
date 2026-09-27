import { randomBytes } from "node:crypto";

export const SERVICE_NAME = "group13-telemetry-simulator";
export const SIMULATOR_VERSION = "1.0.0";

/**
 * Run IDs combine UTC date/time with a random suffix, so IDs never collide across
 * restarts. Event IDs embed the run token, which keeps them unique across all runs.
 */
export function createRunToken(now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-09-27T12:00:00.000Z
  const date = iso.slice(0, 10).replaceAll("-", "");
  const time = iso.slice(11, 19).replaceAll(":", "");
  return `${date}_${time}_${randomBytes(2).toString("hex")}`;
}

export function runIdFromToken(token: string): string {
  return `run_${token}`;
}

export function tokenFromRunId(runId: string): string {
  return runId.replace(/^(run|test)_/, "");
}

export function eventIdFor(runId: string, sequence: number): string {
  return `evt_${tokenFromRunId(runId)}_${String(sequence).padStart(6, "0")}`;
}
