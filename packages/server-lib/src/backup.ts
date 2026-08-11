import { randomUUID } from "node:crypto";
import type pg from "pg";
import { zipSync, unzipSync } from "fflate";
import { put, del } from "@vercel/blob";
import {
  BACKUP_ARCHIVE_VERSION,
  SYNCABLE_TABLES,
  type BackupManifest,
  type BackupTable,
  type BackupRecord,
} from "@house/shared";
import { TABLE_SPECS, selectAllSyncRows, restoreSyncRow } from "./sync-tables.js";
import { hashPassword } from "./auth.js";

/**
 * Same allow-list as api/blob/upload.ts's onBeforeGenerateToken, since
 * these are the content types a photo could ever have been uploaded with
 * in the first place.
 */
const PHOTO_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

function jsonFile(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function parseJsonEntry<T>(files: Record<string, Uint8Array>, path: string): T {
  const bytes = files[path];
  if (!bytes) throw new Error(`backup archive is missing ${path}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function extensionFromUrl(url: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(new URL(url).pathname);
  return match ? match[1].toLowerCase() : "jpg";
}

interface PropertyRow {
  id: string;
  name: string;
  type: string;
  createdAt: string;
}
interface UserRow {
  id: string;
  username: string;
  createdAt: string;
}
interface PropertyMemberRow {
  userId: string;
  propertyId: string;
  role: string;
}

export interface BuildBackupResult {
  buffer: Buffer;
  manifest: BackupManifest;
}

/**
 * Snapshots every table in BACKUP_TABLES (packages/shared/src/backup.ts)
 * plus every reading's photo bytes into one zip archive, entirely
 * in-memory. Deliberately excludes `password_hash` from the `users`
 * dump — see restoreBackupArchive's doc comment for why, and
 * anomaly_flags/push_subscriptions entirely (computed/device-specific,
 * regenerate naturally, nothing lost by leaving them out).
 *
 * In-memory buffering is a real v1 limitation worth stating plainly: this
 * is sized for a personal app's realistic data volume (years of meter
 * readings + photos, likely low tens of MB), not a multi-GB photo
 * library. A future version could stream straight to Blob instead of
 * building the whole zip in memory first.
 */
export async function buildBackupArchive(pool: pg.Pool): Promise<BuildBackupResult> {
  const files: Record<string, Uint8Array> = {};
  const tableCounts: Record<string, number> = {};

  const { rows: propertyRows } = await pool.query<{ id: string; name: string; type: string; created_at: Date }>(
    "SELECT id, name, type, created_at FROM properties"
  );
  const properties: PropertyRow[] = propertyRows.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    createdAt: p.created_at.toISOString(),
  }));
  files["data/properties.json"] = jsonFile(properties);
  tableCounts.properties = properties.length;

  const { rows: userRows } = await pool.query<{ id: string; username: string; created_at: Date }>(
    "SELECT id, username, created_at FROM users"
  );
  const users: UserRow[] = userRows.map((u) => ({
    id: u.id,
    username: u.username,
    createdAt: u.created_at.toISOString(),
  }));
  files["data/users.json"] = jsonFile(users);
  tableCounts.users = users.length;

  const { rows: memberRows } = await pool.query<{ user_id: string; property_id: string; role: string }>(
    "SELECT user_id, property_id, role FROM property_members"
  );
  const propertyMembers: PropertyMemberRow[] = memberRows.map((m) => ({
    userId: m.user_id,
    propertyId: m.property_id,
    role: m.role,
  }));
  files["data/propertyMembers.json"] = jsonFile(propertyMembers);
  tableCounts.propertyMembers = propertyMembers.length;

  for (const table of SYNCABLE_TABLES) {
    const rows = await selectAllSyncRows(pool, TABLE_SPECS[table]);
    files[`data/${table}.json`] = jsonFile(rows);
    tableCounts[table] = rows.length;
  }

  const { rows: photoRows } = await pool.query<{ id: string; photo_blob_url: string }>(
    "SELECT id, photo_blob_url FROM readings WHERE photo_blob_url IS NOT NULL"
  );
  let photoCount = 0;
  for (const { id, photo_blob_url } of photoRows) {
    try {
      const res = await fetch(photo_blob_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      files[`photos/${id}.${extensionFromUrl(photo_blob_url)}`] = new Uint8Array(await res.arrayBuffer());
      photoCount++;
    } catch (err) {
      // A missing/unreachable photo shouldn't abort the whole backup —
      // everything else still gets captured, and this is logged so it's
      // not silently lost either.
      console.error(`buildBackupArchive: failed to fetch photo for reading ${id}`, err);
    }
  }

  const manifest: BackupManifest = {
    version: BACKUP_ARCHIVE_VERSION,
    createdAt: new Date().toISOString(),
    tableCounts: tableCounts as BackupManifest["tableCounts"],
    photoCount,
  };
  files["manifest.json"] = jsonFile(manifest);

  const zipped = zipSync(files, { level: 6 });
  return { buffer: Buffer.from(zipped), manifest };
}

export interface RestoreBackupResult {
  tableCounts: Record<BackupTable, number>;
  photosRestored: number;
  usersCreatedWithDisabledPassword: string[];
}

/**
 * Restores an archive built by buildBackupArchive. Merge-only: every row
 * is upserted, nothing present in the live DB but absent from the archive
 * is ever deleted — a "replace everything" mode is a separate, more
 * dangerous action this deliberately doesn't provide. Table order follows
 * SYNCABLE_TABLES, which is already FK-safe (meters/meterGroups before
 * meterGroupMembers, meters before meterEvents/readings, taskTemplates
 * before taskInstances); properties/users/propertyMembers are restored
 * first since meters and taskTemplates both FK to properties.
 *
 * `users.password_hash` is never written for a user that already exists —
 * the archive doesn't even contain password hashes (see
 * buildBackupArchive), and overwriting the hash of whoever is currently
 * logged in and running this restore would lock out their own session. A
 * brand-new user row (didn't exist before this restore) gets a random,
 * unusable password_hash instead; `usersCreatedWithDisabledPassword`
 * lists those usernames so the caller knows to run `db:seed-user` for
 * them before anyone can log in as that user again.
 */
export async function restoreBackupArchive(pool: pg.Pool, archive: Buffer): Promise<RestoreBackupResult> {
  const files = unzipSync(new Uint8Array(archive));
  const manifest = parseJsonEntry<BackupManifest>(files, "manifest.json");
  if (manifest.version !== BACKUP_ARCHIVE_VERSION) {
    throw new Error(
      `unsupported backup archive version ${manifest.version} (this deployment restores version ${BACKUP_ARCHIVE_VERSION})`
    );
  }

  const tableCounts: Record<string, number> = {};

  // Reference tables are restored best-effort, one bad row at a time —
  // matching the SYNCABLE_TABLES loop below rather than letting a single
  // constraint violation (e.g. a stale/duplicate username no-opping a
  // users insert, then its propertyMembers row hitting an FK violation)
  // abort the entire restore, including every syncable table and photo
  // that would otherwise have restored fine.

  const properties = parseJsonEntry<PropertyRow[]>(files, "data/properties.json");
  let propertiesRestored = 0;
  for (const p of properties) {
    try {
      await pool.query(
        `INSERT INTO properties (id, name, type, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type`,
        [p.id, p.name, p.type, p.createdAt]
      );
      propertiesRestored++;
    } catch (err) {
      console.error(`restoreBackupArchive: failed to restore properties/${p.id}`, err);
    }
  }
  tableCounts.properties = propertiesRestored;

  const users = parseJsonEntry<UserRow[]>(files, "data/users.json");
  const usersCreatedWithDisabledPassword: string[] = [];
  let usersRestored = 0;
  for (const u of users) {
    try {
      const { rows: existing } = await pool.query<{ id: string }>("SELECT id FROM users WHERE id = $1", [u.id]);
      if (existing.length > 0) {
        await pool.query("UPDATE users SET username = $1 WHERE id = $2", [u.username, u.id]);
      } else {
        const disabledHash = await hashPassword(randomUUID());
        const inserted = await pool.query(
          `INSERT INTO users (id, username, password_hash, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (username) DO NOTHING`,
          [u.id, u.username, disabledHash, u.createdAt]
        );
        if ((inserted.rowCount ?? 0) > 0) {
          usersCreatedWithDisabledPassword.push(u.username);
        }
      }
      usersRestored++;
    } catch (err) {
      console.error(`restoreBackupArchive: failed to restore users/${u.id}`, err);
    }
  }
  tableCounts.users = usersRestored;

  const propertyMembers = parseJsonEntry<PropertyMemberRow[]>(files, "data/propertyMembers.json");
  let propertyMembersRestored = 0;
  for (const m of propertyMembers) {
    try {
      await pool.query(
        `INSERT INTO property_members (user_id, property_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, property_id) DO UPDATE SET role = EXCLUDED.role`,
        [m.userId, m.propertyId, m.role]
      );
      propertyMembersRestored++;
    } catch (err) {
      console.error(`restoreBackupArchive: failed to restore propertyMembers/${m.userId}/${m.propertyId}`, err);
    }
  }
  tableCounts.propertyMembers = propertyMembersRestored;

  for (const table of SYNCABLE_TABLES) {
    const spec = TABLE_SPECS[table];
    const rows = parseJsonEntry<Record<string, unknown>[]>(files, `data/${table}.json`);
    let restored = 0;
    for (const row of rows) {
      try {
        await restoreSyncRow(pool, spec, row);
        restored++;
      } catch (err) {
        console.error(`restoreBackupArchive: failed to restore ${table}/${(row as { id?: unknown }).id}`, err);
      }
    }
    tableCounts[table] = restored;
  }

  let photosRestored = 0;
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith("photos/")) continue;
    const filename = path.slice("photos/".length);
    const dot = filename.lastIndexOf(".");
    const readingId = dot === -1 ? filename : filename.slice(0, dot);
    const ext = dot === -1 ? "jpg" : filename.slice(dot + 1).toLowerCase();
    const contentType = PHOTO_CONTENT_TYPE_BY_EXTENSION[ext] ?? "application/octet-stream";
    try {
      // Only fill in a MISSING photo — never re-upload/replace one the
      // reading already has. Merge-only restore is meant to backfill
      // what's absent, not churn what's already fine: without this guard,
      // every restore (including a harmless no-op "nothing was actually
      // wrong" run) re-uploads a fresh duplicate of every existing photo
      // and rewrites photo_blob_url on every affected reading, leaving
      // the previous blob orphaned in storage — confirmed by testing this
      // against real data before adding the guard.
      //
      // The check has to be the UPDATE's WHERE clause, not a separate
      // preceding SELECT: two restores running close together (or a
      // restore racing a live photo attach on the same reading) could
      // both pass a plain SELECT check before either writes, reproducing
      // the exact duplicate-upload bug this guard exists to prevent. So:
      // upload first, then attempt the UPDATE gated on `photo_blob_url IS
      // NULL`; if it matches zero rows, something else won the race (or
      // the reading vanished) and the just-uploaded blob is deleted
      // rather than left orphaned.
      const blob = await put(`readings/${readingId}/restored-${Date.now()}.${ext}`, Buffer.from(bytes), {
        access: "public",
        addRandomSuffix: true,
        contentType,
      });
      // Same dedicated-path rule as api/readings/[id]/photo.ts: only this
      // targeted UPDATE ever writes photo_blob_url, never the generic
      // restoreSyncRow above (readings' TABLE_SPEC excludes that column).
      const { rowCount } = await pool.query(
        "UPDATE readings SET photo_blob_url = $1, updated_at = now() WHERE id = $2 AND photo_blob_url IS NULL",
        [blob.url, readingId]
      );
      if ((rowCount ?? 0) > 0) {
        photosRestored++;
      } else {
        await del(blob.url).catch((delErr) =>
          console.error(`restoreBackupArchive: lost the race attaching a photo for reading ${readingId}; failed to clean up the now-orphaned upload`, delErr)
        );
      }
    } catch (err) {
      console.error(`restoreBackupArchive: failed to restore photo for reading ${readingId}`, err);
    }
  }

  return {
    tableCounts: tableCounts as Record<BackupTable, number>,
    photosRestored,
    usersCreatedWithDisabledPassword,
  };
}

/** Raw shape of a `backups` row as node-postgres returns it (snake_case, bigint-as-string). */
export interface BackupRow {
  id: string;
  kind: string;
  status: string;
  blob_url: string | null;
  blob_pathname: string | null;
  size_bytes: string | null;
  table_counts: Record<string, number> | null;
  photo_count: number | null;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export const BACKUP_ROW_COLUMNS =
  "id, kind, status, blob_url, blob_pathname, size_bytes, table_counts, photo_count, error, created_at, completed_at";

/** node-postgres returns `bigint` columns as strings (avoids silent precision loss) — parsed back to number here. */
export function mapBackupRow(row: BackupRow): BackupRecord {
  return {
    id: row.id,
    kind: row.kind as BackupRecord["kind"],
    status: row.status as BackupRecord["status"],
    sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : null,
    tableCounts: row.table_counts as BackupRecord["tableCounts"],
    photoCount: row.photo_count,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}
