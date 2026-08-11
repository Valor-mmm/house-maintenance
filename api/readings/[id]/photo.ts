import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readingPhotoAttachInputSchema } from "@house/shared";
import { getPool } from "@house/server-lib";
import { requireSession, readJsonBody } from "../../_lib/http.js";

/**
 * The ONLY writer of readings.photo_blob_url — deliberately separate from
 * the generic sync push path. See docs/sync-design.md "Photo attach".
 * Bumps updated_at (so the row propagates to other devices on their next
 * pull); the client's pull-merge treats photoBlobUrl as its own merge
 * axis so this bump can't clobber a concurrent unrelated field edit.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const session = await requireSession(req, res);
  if (!session) return;

  const readingId = req.query.id;
  const parsed = readingPhotoAttachInputSchema.safeParse({
    ...readJsonBody<Record<string, unknown>>(req),
    readingId,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "invalid request", issues: parsed.error.issues });
    return;
  }

  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE readings SET photo_blob_url = $1, updated_at = now()
     WHERE id = $2 AND deleted_at IS NULL`,
    [parsed.data.photoBlobUrl, parsed.data.readingId]
  );
  if (rowCount === 0) {
    res.status(404).json({ error: "reading not found" });
    return;
  }

  res.status(200).json({ ok: true });
}
