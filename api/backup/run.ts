import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put } from "@vercel/blob";
import { backupRecordSchema } from "@house/shared";
import { getPool, buildBackupArchive, mapBackupRow, BACKUP_ROW_COLUMNS, type BackupRow } from "@house/server-lib";
import { requireSession } from "../_lib/http.js";

/**
 * Manual "Backup now" trigger (see apps/web/src/routes/Backups.tsx). Runs
 * the same archive builder as api/cron/backup.ts's automated path, tagged
 * kind='manual' and never subject to that cron's retention pruning.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const session = await requireSession(req, res);
  if (!session) return;

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN is not set; backups are unavailable");
    res.status(500).json({ error: "Backups are not configured on this server (BLOB_READ_WRITE_TOKEN is not set)." });
    return;
  }

  const pool = getPool();
  const { rows: created } = await pool.query<BackupRow>(
    `INSERT INTO backups (kind, status) VALUES ('manual', 'running') RETURNING ${BACKUP_ROW_COLUMNS}`
  );
  const backupId = created[0].id;

  try {
    const { buffer, manifest } = await buildBackupArchive(pool);
    const pathname = `backups/${new Date().toISOString().replace(/[:.]/g, "-")}-manual-${backupId}.zip`;
    const blob = await put(pathname, buffer, {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/zip",
    });

    const { rows: updated } = await pool.query<BackupRow>(
      `UPDATE backups SET status = 'complete', blob_url = $1, blob_pathname = $2, size_bytes = $3,
              table_counts = $4, photo_count = $5, completed_at = now()
       WHERE id = $6
       RETURNING ${BACKUP_ROW_COLUMNS}`,
      [blob.url, pathname, buffer.byteLength, JSON.stringify(manifest.tableCounts), manifest.photoCount, backupId]
    );
    res.status(200).json(backupRecordSchema.parse(mapBackupRow(updated[0])));
  } catch (err) {
    console.error(`backup run ${backupId} failed`, err);
    await pool.query(`UPDATE backups SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`, [
      err instanceof Error ? err.message : "unknown error",
      backupId,
    ]);
    res.status(500).json({ error: "backup failed" });
  }
}
