import type { VercelRequest, VercelResponse } from "@vercel/node";
import { backupRestoreRequestSchema, backupRestoreResponseSchema } from "@house/shared";
import { getPool, restoreBackupArchive } from "@house/server-lib";
import { requireSession, readJsonBody } from "../_lib/http.js";

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
 * Security: `blobUrl` is client-supplied, and this handler fetches
 * whatever URL it's given — without a check, an authenticated user could
 * hand it an arbitrary internal/external URL and turn this into an SSRF
 * proxy (fetch cloud metadata endpoints, internal services, etc.), or a
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const session = await requireSession(req, res);
  if (!session) return;

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
