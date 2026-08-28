/**
 * Pure helpers behind the service worker's `push` / `notificationclick`
 * handlers (src/sw.ts). They live in their own module so the actual
 * decisions are unit-testable: sw.ts is wiring only, and importing it
 * under vitest would immediately run `self.addEventListener` against a
 * jsdom global that is not a ServiceWorkerGlobalScope.
 *
 * The payload shape mirrors `PushPayload` in
 * packages/server-lib/src/push.ts. apps/web can't import from the api/
 * side of the workspace, so the two are kept in sync by hand — same
 * reasoning as the duplicated interval table in api/cron.ts.
 */

export interface PushNotificationPayload {
  title: string;
  body: string;
  /** Same-origin path the notification should open, e.g. "/meters". */
  url?: string;
  /**
   * Collapse key. Two notifications sharing a tag replace each other
   * instead of stacking, so a standing condition can't pile up day after
   * day. Only set it where replacing is actually correct — see the
   * per-notification choices in api/cron.ts.
   */
  tag?: string;
}

/**
 * Shown when a push arrives with no body, or with one we can't parse.
 * We must show *something*: the subscription is `userVisibleOnly`, so
 * staying silent makes Chrome substitute its own generic "site updated
 * in the background" notification anyway — better to be honest about it
 * and still deep-link into the app.
 */
export const FALLBACK_NOTIFICATION: PushNotificationPayload = {
  title: "House Maintenance",
  body: "Open the app to see what's new.",
  url: "/",
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Parses a push payload, degrading to FALLBACK_NOTIFICATION rather than throwing. */
export function parsePushPayload(raw: string | null | undefined): PushNotificationPayload {
  if (!isNonEmptyString(raw)) return FALLBACK_NOTIFICATION;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return FALLBACK_NOTIFICATION;
  }
  if (typeof parsed !== "object" || parsed === null) return FALLBACK_NOTIFICATION;
  const candidate = parsed as Record<string, unknown>;
  if (!isNonEmptyString(candidate.title) || !isNonEmptyString(candidate.body)) {
    return FALLBACK_NOTIFICATION;
  }
  return {
    title: candidate.title,
    body: candidate.body,
    url: isNonEmptyString(candidate.url) ? candidate.url : undefined,
    tag: isNonEmptyString(candidate.tag) ? candidate.tag : undefined,
  };
}

/**
 * `NotificationOptions` plus `renotify`, which Chrome very much supports
 * but TypeScript's DOM/WebWorker libs no longer declare. Declared here
 * rather than cast away at the call site, so the property still gets
 * checked.
 */
export interface PushNotificationOptions extends NotificationOptions {
  renotify?: boolean;
}

export function buildNotificationOptions(
  payload: PushNotificationPayload
): PushNotificationOptions {
  return {
    body: payload.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: payload.tag,
    // Chrome throws a TypeError on `renotify` without a `tag`, so this
    // is conditional rather than a constant true. With a tag it's what
    // makes the replacement still buzz — a silently swapped-out
    // notification would otherwise go unnoticed.
    ...(payload.tag ? { renotify: true } : {}),
    data: { url: payload.url ?? "/" },
  };
}

/**
 * The path to open for a clicked notification.
 *
 * Deliberately only accepts a same-origin absolute path: the value
 * originates in a push message, and anything else (an absolute URL, a
 * protocol-relative "//evil.example") would let whoever can send this
 * origin a push turn a notification tap into navigation to a site of
 * their choosing.
 */
export function resolveNotificationUrl(data: unknown): string {
  if (typeof data !== "object" || data === null) return "/";
  const url = (data as Record<string, unknown>).url;
  if (typeof url !== "string") return "/";
  if (!url.startsWith("/") || url.startsWith("//")) return "/";
  return url;
}
