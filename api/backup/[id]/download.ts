import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "@house/server-lib";
import { requireSession } from "../../_lib/http.js";

/**
 * Proxies the archive through this authenticated endpoint rather than
 * handing the client the Blob URL directly. Unlike photos (which are
 * individually low-value and already public-by-obscurity per
 * docs/sync-design.md), a backup archive is the whole database — it
 * shouldn't be fetchable by anyone who merely finds/guesses the Blob URL.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const session = await requireSession(req, res);
  if (!session) return;

  const id = req.query.id;
  if (typeof id !== "string") {
    res.status(400).json({ error: "invalid backup id" });
    return;
  }

  const pool = getPool();
  const { rows } = await pool.query<{ blob_url: string | null; status: string; created_at: Date }>(
    "SELECT blob_url, status, created_at FROM backups WHERE id = $1",
    [id]
  );
  const backup = rows[0];
  if (!backup || !backup.blob_url || backup.status !== "complete") {
    res.status(404).json({ error: "backup not found" });
    return;
  }

  const blobRes = await fetch(backup.blob_url);
  if (!blobRes.ok || !blobRes.body) {
    res.status(502).json({ error: "failed to fetch backup archive from storage" });
    return;
  }

  const filename = `house-maintenance-backup-${backup.created_at.toISOString().slice(0, 10)}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const reader = blobRes.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}
