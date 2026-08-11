import type { VercelRequest, VercelResponse } from "@vercel/node";
import { syncPushRequestSchema } from "@house/shared";
import { getPool, TABLE_SPECS, upsertSyncRow } from "@house/server-lib";
import { requireSession, readJsonBody } from "../_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const session = await requireSession(req, res);
  if (!session) return;

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
