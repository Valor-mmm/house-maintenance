import { z } from "zod";
import { uuidSchema, isoDateTimeSchema, syncMetaSchema } from "./common.js";

export const meterTypeSchema = z.enum([
  "electricity_in",
  "electricity_out",
  "water",
  "pressure",
  "custom",
]);
export type MeterType = z.infer<typeof meterTypeSchema>;

export const readingKindSchema = z.enum(["cumulative", "snapshot"]);
export type ReadingKind = z.infer<typeof readingKindSchema>;

export const readingIntervalSchema = z.enum([
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
]);
export type ReadingInterval = z.infer<typeof readingIntervalSchema>;

/** Pressure gauges are snapshots; every other meter type is a cumulative counter. */
export function defaultReadingKindForMeterType(type: MeterType): ReadingKind {
  return type === "pressure" ? "snapshot" : "cumulative";
}

export const meterBaseSchema = z.object({
  propertyId: uuidSchema,
  name: z.string().min(1),
  type: meterTypeSchema,
  unit: z.string().min(1),
  readingInterval: readingIntervalSchema,
  readingKind: readingKindSchema,
  /**
   * Optional per-meter warning bounds — most useful on `snapshot` meters
   * (e.g. a heating/water pressure gauge) where the raw value itself, not
   * a derived consumption, is what should stay in range. See
   * `computePressureTrend` in `pressure-trend.ts` and
   * docs/period-derivation.md "Pressure thresholds & decline trend".
   * `null` means "no bound set" — never a sentinel like 0. Callers that
   * set both must ensure `minThreshold < maxThreshold` themselves (see
   * `apps/web/src/data/meters.ts`) — not enforced here so this schema
   * stays a plain ZodObject that other schemas can `.merge`/`.extend`.
   */
  minThreshold: z.number().nullable(),
  maxThreshold: z.number().nullable(),
});

export const meterSchema = meterBaseSchema.merge(syncMetaSchema);
export type Meter = z.infer<typeof meterSchema>;

export const meterCreateInputSchema = meterBaseSchema.extend({ id: uuidSchema });
export type MeterCreateInput = z.infer<typeof meterCreateInputSchema>;

// --- Meter groups (e.g. "Electricity" = electricity_in + electricity_out) ---

export const meterGroupBaseSchema = z.object({
  propertyId: uuidSchema,
  name: z.string().min(1),
  unit: z.string().min(1),
});
export const meterGroupSchema = meterGroupBaseSchema.merge(syncMetaSchema);
export type MeterGroup = z.infer<typeof meterGroupSchema>;
export const meterGroupCreateInputSchema = meterGroupBaseSchema.extend({ id: uuidSchema });
export type MeterGroupCreateInput = z.infer<typeof meterGroupCreateInputSchema>;

export const meterGroupMemberRoleSchema = z.enum(["in", "out", "other"]);
export type MeterGroupMemberRole = z.infer<typeof meterGroupMemberRoleSchema>;

/** Net value for a group = sum(reading.value * signMultiplier) across its members. */
export const meterGroupMemberBaseSchema = z.object({
  groupId: uuidSchema,
  meterId: uuidSchema,
  role: meterGroupMemberRoleSchema,
  signMultiplier: z.union([z.literal(1), z.literal(-1)]),
});
export const meterGroupMemberSchema = meterGroupMemberBaseSchema.merge(syncMetaSchema);
export type MeterGroupMember = z.infer<typeof meterGroupMemberSchema>;
export const meterGroupMemberCreateInputSchema = meterGroupMemberBaseSchema.extend({
  id: uuidSchema,
});
export type MeterGroupMemberCreateInput = z.infer<typeof meterGroupMemberCreateInputSchema>;

// --- Meter events (reset / replacement) ---
// Delta calculations must never bridge a period across one of these
// without special-casing it — see docs/period-derivation.md.

export const meterEventTypeSchema = z.enum(["reset", "replaced"]);
export type MeterEventType = z.infer<typeof meterEventTypeSchema>;

export const meterEventBaseSchema = z.object({
  meterId: uuidSchema,
  eventType: meterEventTypeSchema,
  occurredAt: isoDateTimeSchema,
  preEventFinalValue: z.number(),
  postEventStartValue: z.number(),
});
export const meterEventSchema = meterEventBaseSchema.merge(syncMetaSchema);
export type MeterEvent = z.infer<typeof meterEventSchema>;
export const meterEventCreateInputSchema = meterEventBaseSchema.extend({ id: uuidSchema });
export type MeterEventCreateInput = z.infer<typeof meterEventCreateInputSchema>;
