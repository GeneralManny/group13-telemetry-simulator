import { describe, expect, it } from "vitest";
import { validateEvent } from "../../src/contracts/validation.js";
import { FaultInjector } from "../../src/scenarios/failure-modes.js";
import { resolve, simulate } from "../helpers/index.js";

function injectAll(body: object) {
  const { config, events } = simulate(body);
  const injector = new FaultInjector(config.failure_modes!, config.seed);
  return events.flatMap((e) => injector.apply(e));
}

describe("fault injector", () => {
  const outgoing = injectAll({
    scenario: "pipeline_failure",
    seed: 11,
    failure_modes: { rate: 0.2 },
  });
  const byFault = (f: string) => outgoing.filter((o) => o.fault === f);

  it("injects every enabled fault type", () => {
    for (const f of ["duplicate", "missing_field", "malformed", "delayed", "stale_timestamp"]) {
      expect(byFault(f).length).toBeGreaterThan(0);
    }
  });

  it("duplicates keep the original event ID and sequence number", () => {
    for (const dup of byFault("duplicate")) {
      const originals = outgoing.filter((o) => o.eventId === dup.eventId);
      expect(originals).toHaveLength(2);
      expect(dup.payload.event_id).toBe(dup.eventId);
      expect(dup.payload.sequence_number).toBe(dup.sequence);
    }
  });

  it("missing-field and malformed events fail the contract", () => {
    for (const o of [...byFault("missing_field"), ...byFault("malformed")]) {
      expect(validateEvent(o.payload).success).toBe(false);
    }
  });

  it("delayed events carry the configured delay", () => {
    for (const o of byFault("delayed")) expect(o.delayMs).toBe(8000);
  });

  it("stale events carry an older timestamp but remain valid", () => {
    for (const o of byFault("stale_timestamp")) {
      expect(validateEvent(o.payload).success).toBe(true);
      expect(Date.now() - Date.parse(String(o.payload.timestamp))).toBeGreaterThan(590_000);
    }
  });

  it("never touches match lifecycle or odds events", () => {
    for (const o of outgoing.filter((x) => x.fault)) {
      expect(["player_action", "combat_event", "player_snapshot"]).toContain(o.eventType);
    }
  });

  it("is deterministic for a given seed", () => {
    const again = injectAll({
      scenario: "pipeline_failure",
      seed: 11,
      failure_modes: { rate: 0.2 },
    });
    expect(again.map((o) => [o.sequence, o.fault])).toEqual(
      outgoing.map((o) => [o.sequence, o.fault]),
    );
  });

  it("only bursts inside the configured window", () => {
    const c = resolve({ scenario: "pipeline_failure" });
    const injector = new FaultInjector(c.failure_modes!, 1);
    expect(injector.burstExtras(29)).toBe(0);
    expect(injector.burstExtras(30)).toBe(4);
    expect(injector.burstExtras(39.5)).toBe(4);
    expect(injector.burstExtras(40)).toBe(0);
  });
});
