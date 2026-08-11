import { z } from "zod";
import { isoDateTimeSchema } from "./common.js";

/**
 * Result shapes for the period-derivation algorithm in
 * docs/period-derivation.md. `consumption: null` means the boundary was
 * undefined (no data close enough to interpolate) — always distinguish
 * this from `0`, both here and in any chart/stat that consumes it.
 */
export const periodConsumptionSchema = z.object({
  periodStart: isoDateTimeSchema,
  periodEnd: isoDateTimeSchema,
  consumption: z.number().nullable(),
});
export type PeriodConsumption = z.infer<typeof periodConsumptionSchema>;

/** Stats are computed over non-null derived monthly consumption values, never raw cumulative readings. */
export const periodStatsSchema = z.object({
  average: z.number().nullable(),
  median: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  sampleCount: z.number().int().nonnegative(),
});
export type PeriodStats = z.infer<typeof periodStatsSchema>;

export const meterOverviewResponseSchema = z.object({
  monthly: z.array(periodConsumptionSchema),
  stats: periodStatsSchema,
});
export type MeterOverviewResponse = z.infer<typeof meterOverviewResponseSchema>;
