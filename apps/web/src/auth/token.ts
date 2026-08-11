const SESSION_MARKER_COOKIE = "session_present";

/**
 * The real session lives in an httpOnly cookie set by the server
 * (api/auth/login.ts) — deliberately unreadable from JS, so an XSS bug
 * can't exfiltrate it (see SECURITY.md). This marker cookie carries no
 * secret, just a presence flag set/cleared alongside it, so route guards
 * here can stay a synchronous check instead of pinging the server on
 * every navigation.
 */
export function hasSession(): boolean {
  return document.cookie.split("; ").some((entry) => entry.startsWith(`${SESSION_MARKER_COOKIE}=`));
}

/**
 * Clears the marker immediately for instant UI feedback, then asks the
 * server to clear the real session cookie. Best-effort: if the request
 * never lands (offline), the marker above already reflects "logged out"
 * locally, and the httpOnly cookie simply expires on its own (30d).
 */
export async function logout(): Promise<void> {
  document.cookie = `${SESSION_MARKER_COOKIE}=; Path=/; Max-Age=0`;
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    // See doc comment above — offline/unreachable is fine.
  }
}

/** fetch wrapper for API calls; the session cookie rides along automatically for same-origin requests. */
export function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return fetch(input, { ...init, headers, credentials: "same-origin" });
}
