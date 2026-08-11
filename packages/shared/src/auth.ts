import { z } from "zod";
import { uuidSchema } from "./common.js";

export const authUserSchema = z.object({
  id: uuidSchema,
  username: z.string().min(1),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// No token field: the session lives in an httpOnly cookie the server sets
// directly (api/auth/login.ts), never in a JS-readable response body.
export const loginResponseSchema = z.object({
  user: authUserSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;
