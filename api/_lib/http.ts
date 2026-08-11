import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifySession, type SessionPayload } from "@house/server-lib";

const SESSION_COOKIE = "session";
// Not httpOnly and carries no secret (just presence) — lets client-side JS
// (apps/web/src/auth/token.ts's hasSession()) gate routes with a
// synchronous document.cookie check instead of pinging the server on every
// navigation. The actual security boundary is SESSION_COOKIE, verified
// server-side by requireSession on every real endpoint regardless of what
// this marker says.
const SESSION_MARKER_COOKIE = "session_present";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // matches signSession's 30d expiry

// vercel dev (local) sets VERCEL_ENV=development and serves over plain
// HTTP; every deployed environment (production, preview) is HTTPS. A
// cookie marked Secure is dropped outright by the browser over HTTP, which
// would break login in local dev if this weren't conditional.
function cookieIsSecure(): boolean {
  return process.env.VERCEL_ENV !== "development";
}

export function getSessionCookie(req: VercelRequest): string | null {
  return req.cookies[SESSION_COOKIE] ?? null;
}

/** Verifies the session cookie; writes a 401 response itself and returns null if absent/invalid. */
export async function requireSession(
  req: VercelRequest,
  res: VercelResponse
): Promise<SessionPayload | null> {
  const token = getSessionCookie(req);
  if (!token) {
    res.status(401).json({ error: "missing session cookie" });
    return null;
  }
  try {
    return await verifySession(token);
  } catch {
    res.status(401).json({ error: "invalid or expired session" });
    return null;
  }
}

export function setSessionCookies(res: VercelResponse, token: string): void {
  const secure = cookieIsSecure() ? "; Secure" : "";
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`,
    `${SESSION_MARKER_COOKIE}=1; Path=/; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`,
  ]);
}

export function clearSessionCookies(res: VercelResponse): void {
  const secure = cookieIsSecure() ? "; Secure" : "";
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    `${SESSION_MARKER_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0${secure}`,
  ]);
}

export function readJsonBody<T>(req: VercelRequest): T {
  return (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as T;
}
