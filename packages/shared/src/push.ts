import { z } from "zod";
import { uuidSchema } from "./common.js";

export const pushSubscriptionKeysSchema = z.object({
  p256dh: z.string(),
  auth: z.string(),
});
export type PushSubscriptionKeys = z.infer<typeof pushSubscriptionKeysSchema>;

/** Server-authoritative — registered directly via the Push API, not offline-synced. */
export const pushSubscriptionSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  endpoint: z.string().url(),
  keys: pushSubscriptionKeysSchema,
});
export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

export const pushSubscriptionCreateInputSchema = pushSubscriptionSchema.omit({ id: true });
export type PushSubscriptionCreateInput = z.infer<typeof pushSubscriptionCreateInputSchema>;
