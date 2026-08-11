import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put } from "@vercel/blob";
import {
  backupRecordSchema,
  backupListResponseSchema,
  backupRestoreRequestSchema,
  backupRestoreResponseSchema,
} from "@house/shared";
import {
  getPool,
  buildBackupArchive,
  restoreBackupArchive,
  mapBackupRow,
  BACKUP_ROW_COLUMNS,
  type BackupRow,
} from "@house/server-lib";
import { requireSession, readJsonBody } from "./_lib/http.js";

/**
 * Consolidated backup resource — list/run/restore/download in one file,
 * dispatched by method + `action` query param, instead of four separate
 * files as originally built. Vercel's Hobby plan caps a deployment at 12
 * Serverless Functions; this project hit that cap (confirmed by an actual
 * failed production deploy, not a guess) once backup/list/run/restore/
 * download existed as separate files alongside everything else under
 * api/. api/backup/upload.ts stays separate — it's structurally tied to
 * `@vercel/blob/client`'s fixed `handleUploadUrl`, not something that
 * benefits from folding in here.
 *
 *   GET  /api/backup                       -> list
 *   GET  /api/backup?action=download&id=X  -> download (proxied)
 *   POST /api/backup                       -> run (manual backup)
 *   POST /api/backup?action=restore        -> restore
 *
 * Auth is checked once here, before dispatch, rather than duplicated in
 * every sub-handler — all four actions require the same session gate.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;

  const action = typeof req.query.action === "string" ? req.query.action : undefined;

  if (req.method === "GET" && action === "download") {
    await handleDownload(req, res);
    return;
  }
  if (req.method === "GET") {
    await handleList(res);
    return;
  }
  if (req.method === "POST" && action === "restore") {
    await handleRestore(req, res);
    return;
  }
  if (req.method === "POST") {
    await handleRun(res);
    return;
  }
  res.status(405).json({ error: "method not allowed" });
}

async function handleList(res: VercelResponse): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<BackupRow>(
    `SELECT ${BACKUP_ROW_COLUMNS} FROM backups ORDER BY created_at DESC LIMIT 50`
  );
  res.status(200).json(backupListResponseSchema.parse(rows.map(mapBackupRow)));
}

async function handleRun(res: VercelResponse): Promise<void> {
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

/**
 * Proxies the archive through this authenticated endpoint rather than
 * handing the client the Blob URL directly. Unlike photos (individually
 * low-value, already public-by-obscurity per docs/sync-design.md), a
 * backup archive is the whole database — it shouldn't be fetchable by
 * anyone who merely finds/guesses the Blob URL.
 */
async function handleDownload(req: VercelRequest, res: VercelResponse): Promise<void> {
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

/**
 * Restores from either an existing backup this deployment already knows
 * about (`backupId`) or an archive the client just uploaded via
 * api/backup/upload.ts (`blobUrl`) — the latter is what makes disaster
 * recovery from an offsite copy (Proton Drive) possible once this
 * deployment's own `backups` rows are gone too. See
 * packages/server-lib/src/backup.ts for the actual restore logic and its
 * merge/FK-order/password-safety rules.
 *
 * Bootstrapping note (documented, not solved here): this endpoint
 * requires a valid session, so it cannot help if `users` itself has been
 * completely wiped — that scenario needs `db/seed-user.mjs` run first to
 * get one working login, same as a first-time deploy (docs/deployment.md
 * step 4), before this restore path can do the rest.
 *
 * Security: `blobUrl` is client-supplied, and this fetches whatever URL
 * it's given — without a check, an authenticated user could hand it an
 * arbitrary internal/external URL and turn this into an SSRF proxy, or a
 * multi-GB URL to exhaust function memory. `isAllowedArchiveUrl` pins the
 * target to this project's own Blob store (the `*.public.blob.
 * vercel-storage.com` host, under the exact prefixes this app's own
 * upload/backup flows ever write to) and `fetchArchiveWithSizeCap` bounds
 * how many bytes get buffered, matching api/backup/upload.ts's own
 * `maximumSizeInBytes` for the browser-direct-upload path this exists
 * alongside.
 */
const ALLOWED_BLOB_HOST = /\.public\.blob\.vercel-storage\.com$/;
const ALLOWED_BLOB_PREFIXES = ["backups/", "restore-uploads/"];
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

function isAllowedArchiveUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || !ALLOWED_BLOB_HOST.test(parsed.hostname)) return false;
  const path = parsed.pathname.replace(/^\//, "");
  return ALLOWED_BLOB_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Streams the response, aborting as soon as MAX_ARCHIVE_BYTES is exceeded rather than buffering an unbounded body first. */
async function fetchArchiveWithSizeCap(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`failed to fetch archive (${res.status})`);
  }
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error("archive exceeds the maximum allowed size");
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error("archive exceeds the maximum allowed size");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function handleRestore(req: VercelRequest, res: VercelResponse): Promise<void> {
  const parsed = backupRestoreRequestSchema.safeParse(readJsonBody(req));
  if (!parsed.success) {
    res.status(400).json({ error: "invalid request", issues: parsed.error.issues });
    return;
  }

  const pool = getPool();
  let archiveUrl = parsed.data.blobUrl;
  if (parsed.data.backupId) {
    const { rows } = await pool.query<{ blob_url: string | null; status: string }>(
      "SELECT blob_url, status FROM backups WHERE id = $1",
      [parsed.data.backupId]
    );
    const backup = rows[0];
    if (!backup || !backup.blob_url || backup.status !== "complete") {
      res.status(404).json({ error: "backup not found" });
      return;
    }
    archiveUrl = backup.blob_url;
  }
  if (!archiveUrl) {
    res.status(400).json({ error: "no archive to restore from" });
    return;
  }
  if (!isAllowedArchiveUrl(archiveUrl)) {
    res.status(400).json({ error: "archive URL is not in this deployment's Blob store" });
    return;
  }

  try {
    const buffer = await fetchArchiveWithSizeCap(archiveUrl, MAX_ARCHIVE_BYTES);
    const result = await restoreBackupArchive(pool, buffer);
    res.status(200).json(backupRestoreResponseSchema.parse({ ok: true, ...result }));
  } catch (err) {
    console.error("backup restore failed", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "restore failed" });
  }
}
