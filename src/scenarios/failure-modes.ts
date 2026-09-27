import type { SimulatorEvent } from "../contracts/events.js";
import { FAULT_TYPES, type FailureModes, type FaultType } from "../contracts/validation.js";
import { Random, deriveSeed } from "../simulator/random.js";

export interface OutgoingEvent {
  payload: Record<string, unknown>;
  delayMs: number;
  fault: FaultType | null;
  eventId: string;
  eventType: string;
  sequence: number;
}

const ELIGIBLE_TYPES = new Set(["player_action", "combat_event", "player_snapshot"]);
const MISSING_FIELD_ROTATION = [
  "timestamp",
  "match_id",
  "player_id",
  "sequence_number",
  "schema_version",
] as const;
const DUPLICATE_DELAY_MS = 250;

type Mutator = (e: Record<string, unknown>) => void;
const MALFORMED_ROTATION: Mutator[] = [
  (e) => (e.sequence_number = `seq-${String(e.sequence_number)}`),
  (e) => (e.metrics = "not-an-object"),
  (e) => (e.timestamp = "yesterday afternoon"),
  (e) => {
    const metrics = e.metrics as Record<string, unknown>;
    metrics.reaction_time_ms = "fast";
  },
  (e) => (e.player_id = 12345),
];

export function passThrough(event: SimulatorEvent): OutgoingEvent {
  return {
    payload: event as unknown as Record<string, unknown>,
    delayMs: 0,
    fault: null,
    eventId: event.event_id,
    eventType: event.event_type,
    sequence: event.sequence_number,
  };
}

/**
 * Deliberately corrupts a share of eligible events for Team A's reliability tests.
 * Only created when failure modes were requested explicitly. Uses its own random
 * stream so enabling faults does not change match content.
 */
export class FaultInjector {
  private readonly rng: Random;
  private missingCursor = 0;
  private malformedCursor = 0;
  private readonly enabled: FaultType[];

  constructor(
    readonly modes: FailureModes,
    seed: number,
  ) {
    this.rng = new Random(deriveSeed(seed, 2));
    this.enabled = FAULT_TYPES.filter((t) => modes[t]);
  }

  /** Extra events to emit on a tick at match second `t` while the burst window is open. */
  burstExtras(t: number): number {
    const m = this.modes;
    if (!m.burst) return 0;
    const inWindow =
      t >= m.burst_start_second && t < m.burst_start_second + m.burst_duration_seconds;
    return inWindow ? m.burst_multiplier - 1 : 0;
  }

  apply(event: SimulatorEvent): OutgoingEvent[] {
    const original = passThrough(event);
    if (!ELIGIBLE_TYPES.has(event.event_type) || this.enabled.length === 0) return [original];
    if (!this.rng.chance(this.modes.rate)) return [original];

    const fault = this.rng.pick(this.enabled);
    const clone = structuredClone(event) as unknown as Record<string, unknown>;
    const faulty = (payload: Record<string, unknown>, delayMs = 0): OutgoingEvent => ({
      ...original,
      payload,
      delayMs,
      fault,
    });

    switch (fault) {
      case "duplicate":
        return [original, faulty(clone, DUPLICATE_DELAY_MS)];
      case "missing_field": {
        const field = MISSING_FIELD_ROTATION[this.missingCursor++ % MISSING_FIELD_ROTATION.length]!;
        delete clone[field];
        return [faulty(clone)];
      }
      case "malformed":
        MALFORMED_ROTATION[this.malformedCursor++ % MALFORMED_ROTATION.length]!(clone);
        return [faulty(clone)];
      case "delayed":
        return [faulty(clone, this.modes.delay_ms)];
      case "stale_timestamp":
        clone.timestamp = new Date(
          Date.parse(event.timestamp) - this.modes.stale_by_seconds * 1000,
        ).toISOString();
        return [faulty(clone)];
    }
  }
}

/** Applies a single named fault to a test event. */
export function applySingleFault(
  event: SimulatorEvent,
  fault: "none" | "missing_field" | "malformed" | "stale_timestamp",
): Record<string, unknown> {
  const clone = structuredClone(event) as unknown as Record<string, unknown>;
  if (fault === "missing_field") delete clone.timestamp;
  if (fault === "malformed") {
    clone.sequence_number = `seq-${String(clone.sequence_number)}`;
    clone.metrics = "not-an-object";
  }
  if (fault === "stale_timestamp") {
    clone.timestamp = new Date(Date.parse(event.timestamp) - 600_000).toISOString();
  }
  return clone;
}
