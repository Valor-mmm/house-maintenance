import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifySession, type SessionPayload } from "@house/server-lib";

/** Verifies the Bearer token; writes a 401 response itself and returns null if absent/invalid. */
export async function requireSession(
  req: VercelRequest,
  res: VercelResponse
): Promise<SessionPayload | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "missing bearer token" });
    return null;
  }
  try {
    return await verifySession(token);
  } catch {
    res.status(401).json({ error: "invalid or expired token" });
    return null;
  }
}

export function readJsonBody<T>(req: VercelRequest): T {
  return (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as T;
}
