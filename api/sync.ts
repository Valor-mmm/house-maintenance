import type { VercelRequest, VercelResponse } from "@vercel/node";
import { syncPushRequestSchema, syncPullRequestSchema } from "@house/shared";
import { getPool, TABLE_SPECS, upsertSyncRow, pullSyncPage } from "@house/server-lib";
import { requireSession, readJsonBody } from "./_lib/http.js";

/**
 * Consolidated sync endpoint — push and pull in one file, dispatched by
 * an `action` query param, instead of two separate files as originally
 * built. Same reason as api/backup.ts: Vercel's Hobby plan caps a
 * deployment at 12 Serverless Functions.
 *
 *   POST /api/sync?action=push  -> push (apps/web/src/sync/engine.ts's pushTable)
 *   POST /api/sync?action=pull  -> pull (apps/web/src/sync/engine.ts's pullTable)
 *
 * Both actions are POST-only (matching the original two endpoints) and
 * require the same session gate, checked once here before dispatch.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const session = await requireSession(req, res);
  if (!session) return;

  const action = req.query.action;
  if (action === "pull") {
    await handlePull(req, res);
    return;
  }
  if (action === "push") {
    await handlePush(req, res);
    return;
  }
  res.status(400).json({ error: "missing or invalid action query param (expected push or pull)" });
}

async function handlePush(req: VercelRequest, res: VercelResponse): Promise<void> {
  const parsed = syncPushRequestSchema.safeParse(readJsonBody(req));
  if (!parsed.success) {
    res.status(400).json({ error: "invalid request", issues: parsed.error.issues });
    return;
  }

  const { table, rows } = parsed.data;
  const spec = TABLE_SPECS[table];
  const pool = getPool();

  const accepted: string[] = [];
  for (const row of rows) {
    const id = (row as Record<string, unknown>).id;
    if (typeof id !== "string") continue;
    try {
      await upsertSyncRow(pool, spec, row as Record<string, unknown>);
      accepted.push(id);
    } catch (err) {
      // Not accepted: the row stays in the client's outbox and is
      // retried on the next sync pass rather than silently dropped.
      console.error(`sync push upsert failed for ${table}/${id}`, err);
    }
  }

  res.status(200).json({ table, accepted });
}

const PULL_PAGE_SIZE = 500;

async function handlePull(req: VercelRequest, res: VercelResponse): Promise<void> {
  const parsed = syncPullRequestSchema.safeParse(readJsonBody(req));
  if (!parsed.success) {
    res.status(400).json({ error: "invalid request", issues: parsed.error.issues });
    return;
  }

  const { table, cursor } = parsed.data;
  const spec = TABLE_SPECS[table];
  const pool = getPool();

  // Fetch one extra row so hasMore is known without a second round-trip.
  const rows = await pullSyncPage(pool, spec, cursor, PULL_PAGE_SIZE + 1);
  const hasMore = rows.length > PULL_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PULL_PAGE_SIZE) : rows;
  const last = page.length > 0 ? page[page.length - 1] : null;
  const nextCursor = last ? { updatedAt: last.updatedAt as string, id: last.id as string } : cursor;

  res.status(200).json({ table, rows: page, nextCursor, hasMore });
}
