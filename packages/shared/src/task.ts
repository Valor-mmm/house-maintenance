import { z } from "zod";
import { uuidSchema, isoDateTimeSchema, syncMetaSchema } from "./common.js";

export const recurrenceRuleSchema = z.object({
  everyN: z.number().int().positive(),
  unit: z.enum(["days", "weeks", "months", "years"]),
});
export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;

export const taskTemplateBaseSchema = z.object({
  propertyId: uuidSchema,
  name: z.string().min(1),
  category: z.string().min(1),
  recurrenceRule: recurrenceRuleSchema,
});
export const taskTemplateSchema = taskTemplateBaseSchema.merge(syncMetaSchema);
export type TaskTemplate = z.infer<typeof taskTemplateSchema>;
export const taskTemplateCreateInputSchema = taskTemplateBaseSchema.extend({ id: uuidSchema });
export type TaskTemplateCreateInput = z.infer<typeof taskTemplateCreateInputSchema>;

/** cost: single-currency assumption for v1, stated explicitly rather than implied. */
export const taskInstanceBaseSchema = z.object({
  templateId: uuidSchema,
  dueDate: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  completedNote: z.string().nullable().optional(),
  cost: z.number().nonnegative().nullable().optional(),
  lastNotifiedAt: isoDateTimeSchema.nullable().optional(),
});
export const taskInstanceSchema = taskInstanceBaseSchema.merge(syncMetaSchema);
export type TaskInstance = z.infer<typeof taskInstanceSchema>;
export const taskInstanceCreateInputSchema = taskInstanceBaseSchema.extend({ id: uuidSchema });
export type TaskInstanceCreateInput = z.infer<typeof taskInstanceCreateInputSchema>;
