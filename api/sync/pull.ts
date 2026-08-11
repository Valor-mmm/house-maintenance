import type { VercelRequest, VercelResponse } from "@vercel/node";
import { syncPullRequestSchema } from "@house/shared";
import { getPool, TABLE_SPECS, pullSyncPage } from "@house/server-lib";
import { requireSession, readJsonBody } from "../_lib/http.js";

const PAGE_SIZE = 500;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const session = await requireSession(req, res);
  if (!session) return;

  const parsed = syncPullRequestSchema.safeParse(readJsonBody(req));
  if (!parsed.success) {
    res.status(400).json({ error: "invalid request", issues: parsed.error.issues });
    return;
  }

  const { table, cursor } = parsed.data;
  const spec = TABLE_SPECS[table];
  const pool = getPool();

  // Fetch one extra row so hasMore is known without a second round-trip.
  const rows = await pullSyncPage(pool, spec, cursor, PAGE_SIZE + 1);
  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = page.length > 0 ? page[page.length - 1] : null;
  const nextCursor = last
    ? { updatedAt: last.updatedAt as string, id: last.id as string }
    : cursor;

  res.status(200).json({ table, rows: page, nextCursor, hasMore });
}
