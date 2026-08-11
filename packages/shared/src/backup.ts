import { z } from "zod";
import { uuidSchema, isoDateTimeSchema } from "./common.js";
import { SYNCABLE_TABLES, type SyncableTable } from "./sync.js";

/**
 * Reference tables that aren't part of the offline sync engine (see
 * docs/sync-design.md's "server-authoritative" list) but still need to be
 * in a backup archive, because restoring into an empty database would
 * otherwise violate FK constraints (meters.property_id -> properties.id,
 * property_members.user_id -> users.id). `anomalyFlags` and
 * `pushSubscriptions` are deliberately excluded — they're
 * computed/device-specific and regenerate naturally, nothing is lost by
 * leaving them out.
 */
export const BACKUP_REFERENCE_TABLES = ["properties", "users", "propertyMembers"] as const;
export type BackupReferenceTable = (typeof BACKUP_REFERENCE_TABLES)[number];

/** Every table an archive's data/ directory contains one JSON file for. */
export const BACKUP_TABLES = [...BACKUP_REFERENCE_TABLES, ...SYNCABLE_TABLES] as const;
export type BackupTable = BackupReferenceTable | SyncableTable;

export const BACKUP_ARCHIVE_VERSION = 1;

/** manifest.json at the root of every backup archive. */
export const backupManifestSchema = z.object({
  version: z.literal(BACKUP_ARCHIVE_VERSION),
  createdAt: isoDateTimeSchema,
  tableCounts: z.record(z.enum(BACKUP_TABLES), z.number().int().nonnegative()),
  photoCount: z.number().int().nonnegative(),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const backupKindSchema = z.enum(["automated", "manual"]);
export type BackupKind = z.infer<typeof backupKindSchema>;

export const backupStatusSchema = z.enum(["running", "complete", "failed"]);
export type BackupStatus = z.infer<typeof backupStatusSchema>;

/** One row from the `backups` table, as returned by run/list. */
export const backupRecordSchema = z.object({
  id: uuidSchema,
  kind: backupKindSchema,
  status: backupStatusSchema,
  sizeBytes: z.number().int().nonnegative().nullable(),
  tableCounts: z.record(z.enum(BACKUP_TABLES), z.number().int().nonnegative()).nullable(),
  photoCount: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
});
export type BackupRecord = z.infer<typeof backupRecordSchema>;

export const backupListResponseSchema = z.array(backupRecordSchema);
export type BackupListResponse = z.infer<typeof backupListResponseSchema>;

/**
 * Restore source: either a backup already known to this deployment
 * (`backupId`, looked up in the `backups` table) or an archive the client
 * just uploaded via the browser-direct-to-Blob flow (`blobUrl`, same
 * pattern as api/blob/upload.ts) — the latter is what makes disaster
 * recovery from an offsite copy (e.g. Proton Drive) possible once this
 * deployment's own `backups` rows are gone too. Exactly one must be set.
 */
export const backupRestoreRequestSchema = z
  .object({
    backupId: uuidSchema.optional(),
    blobUrl: z.string().url().optional(),
  })
  .refine((v) => Boolean(v.backupId) !== Boolean(v.blobUrl), {
    message: "exactly one of backupId or blobUrl must be set",
  });
export type BackupRestoreRequest = z.infer<typeof backupRestoreRequestSchema>;

export const backupRestoreResponseSchema = z.object({
  ok: z.literal(true),
  tableCounts: z.record(z.enum(BACKUP_TABLES), z.number().int().nonnegative()),
  photosRestored: z.number().int().nonnegative(),
  /**
   * Usernames of `users` rows that didn't already exist and were created
   * with a random, unusable password_hash (see packages/server-lib/src/
   * backup.ts) — an existing user's real password is never touched by
   * restore. The caller must run `db:seed-user` for each of these before
   * they can log in.
   */
  usersCreatedWithDisabledPassword: z.array(z.string()),
});
export type BackupRestoreResponse = z.infer<typeof backupRestoreResponseSchema>;
