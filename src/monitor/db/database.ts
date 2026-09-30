import pg from "pg";
import type { Logger } from "pino";
import { PLAYERS } from "../../data/players.js";
import { computeHistoricalBaselines } from "../engine/baselines.js";
import { DEFAULT_THRESHOLDS } from "../engine/thresholds.js";
import { MIGRATIONS } from "./migrations.js";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
  });
  return pool;
}

/** Runs fn inside one transaction on one connection. Rolls back on any error. */
export async function transaction<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Applies any migration not yet recorded. Safe to run on every start. */
export async function migrate(pool: Pool, logger: Logger): Promise<string[]> {
  await pool.query("CREATE SCHEMA IF NOT EXISTS monitor");
  await pool.query(
    "CREATE TABLE IF NOT EXISTS monitor.schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = new Set(
    (await pool.query<{ id: string }>("SELECT id FROM monitor.schema_migrations")).rows.map(
      (r) => r.id,
    ),
  );
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await transaction(pool, async (c) => {
      await c.query(m.sql);
      await c.query("INSERT INTO monitor.schema_migrations (id) VALUES ($1)", [m.id]);
    });
    applied.push(m.id);
    logger.info({ migration: m.id }, "monitor migration applied");
  }
  return applied;
}

/**
 * Reference data the monitor needs before the first event: the player roster, baselines learned
 * from simulated history, and the default thresholds. Existing baselines and settings are kept,
 * so a reset or restart never changes them.
 */
export async function seedReference(pool: Pool, logger: Logger): Promise<void> {
  await transaction(pool, async (c) => {
    for (const p of PLAYERS) {
      await c.query(
        `INSERT INTO monitor.players (player_id, display_name, team_id, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (player_id) DO UPDATE SET display_name = EXCLUDED.display_name, team_id = EXCLUDED.team_id, role = EXCLUDED.role`,
        [p.player_id, p.display_name, p.team_id, p.role],
      );
    }
    const { rows } = await c.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM monitor.baselines",
    );
    if (Number(rows[0]?.n ?? 0) === 0) {
      const baselines = computeHistoricalBaselines();
      for (const b of baselines) {
        await c.query(
          `INSERT INTO monitor.baselines (player_id, metric, sample_size, mean, stddev, min_value, max_value, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (player_id, metric) DO NOTHING`,
          [b.player_id, b.metric, b.sample_size, b.mean, b.stddev, b.min, b.max, b.source],
        );
      }
      logger.info({ rows: baselines.length }, "baselines seeded from simulated history");
    }
    await c.query(
      `INSERT INTO monitor.settings (key, value) VALUES ('thresholds', $1) ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(DEFAULT_THRESHOLDS)],
    );
  });
}
