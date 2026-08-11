import { z } from "zod";

export const uuidSchema = z.string().uuid();
export const isoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * Fields present on every row that goes through the offline sync engine
 * (meters, meterGroups, meterGroupMembers, meterEvents, readings,
 * taskTemplates, taskInstances). `updatedAt` is ALWAYS assigned by the
 * server on ingestion — never trust or write a client-supplied value into
 * it. See docs/sync-design.md.
 */
export const syncMetaSchema = z.object({
  id: uuidSchema,
  updatedAt: isoDateTimeSchema,
  deletedAt: isoDateTimeSchema.nullable(),
});
export type SyncMeta = z.infer<typeof syncMetaSchema>;
