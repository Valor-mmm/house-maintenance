import pg from "pg";

/**
 * DATABASE_URL must be Neon's pooled (`-pooler`) connection string — a
 * plain `pg.Pool` against the direct hostname misbehaves under a
 * serverless function's per-invocation lifecycle (see the plan's Neon
 * connection note). `max: 1` per function instance is deliberate: Neon's
 * pooler does the real pooling on its side, and each warm Lambda instance
 * only ever needs one connection at a time for this app's traffic.
 */
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString, max: 1 });
  }
  return pool;
}
