/**
 * Exports the version 1.0 event contract as JSON Schema to docs/event-schema.json.
 *
 *   npm run schema
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SCHEMA_VERSION, SimulatorEventSchema } from "../src/contracts/events.js";

const schema = {
  ...z.toJSONSchema(SimulatorEventSchema, { io: "input", unrepresentable: "any" }),
  title: `Group 13 simulator event (schema_version ${SCHEMA_VERSION})`,
  description:
    "One event per webhook request. Discriminated by event_type. Unknown optional fields may be ignored.",
};
const path = join(import.meta.dirname, "..", "docs", "event-schema.json");
writeFileSync(path, JSON.stringify(schema, null, 2) + "\n");
console.log("wrote docs/event-schema.json");
