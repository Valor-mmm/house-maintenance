import { z } from "zod";
import { uuidSchema, isoDateTimeSchema, syncMetaSchema } from "./common.js";

export const exifMetadataSchema = z.object({
  capturedAt: isoDateTimeSchema.nullable(),
  gpsLatitude: z.number().nullable().optional(),
  gpsLongitude: z.number().nullable().optional(),
  raw: z.record(z.unknown()).optional(),
});
export type ExifMetadata = z.infer<typeof exifMetadataSchema>;

export const readingBaseSchema = z.object({
  meterId: uuidSchema,
  value: z.number(),
  capturedAt: isoDateTimeSchema,
  note: z.string().nullable().optional(),
  photoBlobUrl: z.string().url().nullable().optional(),
  photoExif: exifMetadataSchema.nullable().optional(),
});

/** clientEditedAt is the client's own timestamp — audit/UX display only, never used for sync ordering. */
export const readingSchema = readingBaseSchema.merge(syncMetaSchema).extend({
  clientEditedAt: isoDateTimeSchema,
});
export type Reading = z.infer<typeof readingSchema>;

export const readingCreateInputSchema = readingBaseSchema.extend({
  id: uuidSchema,
  clientEditedAt: isoDateTimeSchema,
});
export type ReadingCreateInput = z.infer<typeof readingCreateInputSchema>;

/**
 * Dedicated narrow update — the ONLY way `photoBlobUrl` is written after
 * the initial create. Deliberately excluded from whole-row sync/LWW so the
 * async "photo finishes uploading after reconnect" path can never race
 * with, and silently clobber or be clobbered by, an unrelated field edit
 * on the same reading. See docs/sync-design.md.
 */
export const readingPhotoAttachInputSchema = z.object({
  readingId: uuidSchema,
  photoBlobUrl: z.string().url(),
});
export type ReadingPhotoAttachInput = z.infer<typeof readingPhotoAttachInputSchema>;
