import { z } from "zod";
import { uuidSchema, isoDateTimeSchema } from "./common.js";

/**
 * Server-computed and server-authoritative (not offline-editable), so it
 * does not carry sync metadata — the daily cron writes these directly.
 * `notifiedAt`/`acknowledgedAt` exist purely to de-duplicate pushes: the
 * cron only notifies for a flag it hasn't already notified for.
 */
export const anomalyFlagSchema = z
  .object({
    id: uuidSchema,
    meterId: uuidSchema.nullable(),
    meterGroupId: uuidSchema.nullable(),
    periodStart: isoDateTimeSchema,
    periodEnd: isoDateTimeSchema,
    computedValue: z.number(),
    baselineValue: z.number(),
    pctOver: z.number(),
    notifiedAt: isoDateTimeSchema.nullable(),
    acknowledgedAt: isoDateTimeSchema.nullable(),
  })
  .refine((v) => (v.meterId === null) !== (v.meterGroupId === null), {
    message: "exactly one of meterId or meterGroupId must be set",
  });
export type AnomalyFlag = z.infer<typeof anomalyFlagSchema>;
