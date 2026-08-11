import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./common.js";

/**
 * Compound (updatedAt, id) cursor per docs/sync-design.md — a plain
 * `updatedAt` watermark can silently skip a row synced in the same
 * instant as another. The client must store exactly what the server
 * echoes back in a pull response, never compute this locally.
 */
export const syncCursorSchema = z.object({
  updatedAt: isoDateTimeSchema,
  id: uuidSchema,
});
export type SyncCursor = z.infer<typeof syncCursorSchema>;

/** Tables that go through the generic offline sync engine (push/pull/LWW). */
export const SYNCABLE_TABLES = [
  "meters",
  "meterGroups",
  "meterGroupMembers",
  "meterEvents",
  "readings",
  "taskTemplates",
  "taskInstances",
] as const;
export type SyncableTable = (typeof SYNCABLE_TABLES)[number];

export const syncPullRequestSchema = z.object({
  table: z.enum(SYNCABLE_TABLES),
  cursor: syncCursorSchema.nullable(),
});
export type SyncPullRequest = z.infer<typeof syncPullRequestSchema>;

export const syncPullResponseSchema = z.object({
  table: z.enum(SYNCABLE_TABLES),
  rows: z.array(z.record(z.unknown())),
  nextCursor: syncCursorSchema.nullable(),
  hasMore: z.boolean(),
});
export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;

export const syncPushRequestSchema = z.object({
  table: z.enum(SYNCABLE_TABLES),
  rows: z.array(z.record(z.unknown())),
});
export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;

export const syncPushResponseSchema = z.object({
  table: z.enum(SYNCABLE_TABLES),
  accepted: z.array(uuidSchema),
});
export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;
