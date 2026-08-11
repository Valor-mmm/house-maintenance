import { z } from "zod";
import { uuidSchema } from "./common.js";

/**
 * `properties` and `property_members` are server-authoritative reference
 * data (fetched when online, not offline-editable in v1) — the access
 * seam for a future second property / household sharing, per the plan.
 */

/** The single v1 property seeded by db/migrations/006_seed.sql. */
export const SEEDED_PROPERTY_ID = "00000000-0000-0000-0000-000000000001";

export const propertyTypeSchema = z.enum(["primary_residence", "rental"]);
export type PropertyType = z.infer<typeof propertyTypeSchema>;

export const propertySchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  type: propertyTypeSchema,
});
export type Property = z.infer<typeof propertySchema>;

export const propertyMemberRoleSchema = z.enum(["owner", "member"]);
export type PropertyMemberRole = z.infer<typeof propertyMemberRoleSchema>;

export const propertyMemberSchema = z.object({
  userId: uuidSchema,
  propertyId: uuidSchema,
  role: propertyMemberRoleSchema,
});
export type PropertyMember = z.infer<typeof propertyMemberSchema>;
