import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put, del } from "@vercel/blob";
import {
  getPool,
  buildBackupArchive,
  loadPushSubscriptions,
  sendPushToAll,
  BACKUP_ROW_COLUMNS,
  type BackupRow,
} from "@house/server-lib";

/**
 * Weekly cron (see vercel.json's `crons` entry) — automated backup
 * counterpart to api/cron/daily-sweep.ts, same CRON_SECRET bearer-token
 * gate and same reasoning for it (public HTTPS endpoint, fail closed).
 *
 * Automated backups beyond RETENTION_COUNT are pruned (Blob object + row)
 * so storage doesn't grow unbounded; manual backups (api/backup/run.ts)
 * are never touched here.
 */
const RETENTION_COUNT = 8;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const expectedSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error("backup cron: DATABASE_URL is not set");
    res.status(500).json({ error: "DATABASE_URL is not set" });
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("backup cron: BLOB_READ_WRITE_TOKEN is not set");
    res.status(500).json({ error: "BLOB_READ_WRITE_TOKEN is not set" });
    return;
  }

  const pool = getPool();
  // Same up-front check as daily-sweep.ts: sendPush() throws synchronously
  // if VAPID_* env vars are missing.
  const pushConfigured = Boolean(
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT
  );
  if (!pushConfigured) {
    console.error("backup cron: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT not fully set; push disabled for this run");
  }

  const { rows: created } = await pool.query<BackupRow>(
    `INSERT INTO backups (kind, status) VALUES ('automated', 'running') RETURNING ${BACKUP_ROW_COLUMNS}`
  );
  const backupId = created[0].id;

  const summary = { ok: true, backupId, prunedCount: 0, pushDelivered: false };

  async function notify(title: string, body: string): Promise<void> {
    if (!pushConfigured) return;
    try {
      const subs = await loadPushSubscriptions(pool);
      const result = await sendPushToAll(pool, subs, { title, body, url: "/backups" });
      summary.pushDelivered = result.delivered;
    } catch (err) {
      console.error("backup cron: failed to send push notification", err);
    }
  }

  try {
    const { buffer, manifest } = await buildBackupArchive(pool);
    const pathname = `backups/${new Date().toISOString().replace(/[:.]/g, "-")}-automated-${backupId}.zip`;
    const blob = await put(pathname, buffer, {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/zip",
    });

    await pool.query(
      `UPDATE backups SET status = 'complete', blob_url = $1, blob_pathname = $2, size_bytes = $3,
              table_counts = $4, photo_count = $5, completed_at = now()
       WHERE id = $6`,
      [blob.url, pathname, buffer.byteLength, JSON.stringify(manifest.tableCounts), manifest.photoCount, backupId]
    );

    // Failed runs leave a row with no blob to prune, but nothing else ever
    // reaps them either — without this they'd accumulate forever. Kept
    // separate from the `complete` retention below (different query, no
    // shared OFFSET) so a backlog of failures can never push out a
    // recent, actually-usable completed backup.
    await pool.query(
      `DELETE FROM backups WHERE id IN (
         SELECT id FROM backups WHERE kind = 'automated' AND status = 'failed'
         ORDER BY created_at DESC OFFSET 5
       )`
    );

    const { rows: stale } = await pool.query<{ id: string; blob_pathname: string | null }>(
      `SELECT id, blob_pathname FROM backups
       WHERE kind = 'automated' AND status = 'complete'
       ORDER BY created_at DESC
       OFFSET $1`,
      [RETENTION_COUNT]
    );
    for (const row of stale) {
      if (row.blob_pathname) {
        try {
          await del(row.blob_pathname);
        } catch (err) {
          console.error(`backup cron: failed to delete stale blob ${row.blob_pathname}`, err);
        }
      }
      await pool.query("DELETE FROM backups WHERE id = $1", [row.id]);
    }
    summary.prunedCount = stale.length;

    await notify("Backup complete", `Weekly backup finished (${manifest.photoCount} photos). Tap to save a copy.`);

    res.status(200).json(summary);
  } catch (err) {
    console.error(`backup cron ${backupId} failed`, err);
    await pool.query(`UPDATE backups SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`, [
      err instanceof Error ? err.message : "unknown error",
      backupId,
    ]);
    await notify("Backup failed", "The weekly automated backup failed — check the deployment logs.");
    res.status(500).json({ ok: false, backupId, error: err instanceof Error ? err.message : "unknown error" });
  }
}
