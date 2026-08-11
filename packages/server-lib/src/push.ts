import webpush from "web-push";
import type pg from "pg";
import type { PushSubscription } from "@house/shared";

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT; // e.g. "mailto:you@example.com"
  if (!publicKey || !privateKey || !subject) {
    throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

export type SendPushResult =
  | { ok: true }
  | { ok: false; statusCode?: number; shouldRemove: boolean };

/**
 * Requires the Node.js runtime (uses `web-push`, which needs Node's
 * crypto module) — this is why api/ functions run on Node, not Edge.
 * `shouldRemove: true` means the subscription is gone (uninstalled PWA,
 * expired) and the caller should delete the push_subscriptions row.
 */
export async function sendPush(
  sub: PushSubscription,
  payload: PushPayload
): Promise<SendPushResult> {
  ensureConfigured();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    const shouldRemove = statusCode === 404 || statusCode === 410;
    return { ok: false, statusCode, shouldRemove };
  }
}

export interface PushSubRow {
  id: string;
  user_id: string;
  endpoint: string;
  keys_json: { p256dh: string; auth: string };
}

export async function loadPushSubscriptions(pool: pg.Pool): Promise<PushSubRow[]> {
  const { rows } = await pool.query<PushSubRow>(
    "SELECT id, user_id, endpoint, keys_json FROM push_subscriptions"
  );
  return rows;
}

export interface SendPushToAllResult {
  /** Whether at least one delivery actually succeeded — see the caller notes below. */
  delivered: boolean;
  sent: number;
  removed: number;
}

/**
 * Sends `payload` to every subscription in `subs`, mutating that array in
 * place: a subscription whose delivery reports `shouldRemove` (410/404 —
 * uninstalled PWA, expired) is deleted from `push_subscriptions` and
 * spliced out. Iterates back-to-front so splicing mid-loop is safe.
 *
 * Callers that send several distinct notifications in one run (e.g. the
 * daily sweep's per-task/per-meter/per-anomaly pushes) should load `subs`
 * once via `loadPushSubscriptions` and reuse the same array across every
 * call here, rather than reloading per call — otherwise a subscription
 * already found stale earlier in the run gets redundantly retried (and
 * its DELETE re-issued, a harmless no-op but still wasted work) on every
 * later call in that same run.
 *
 * `delivered: true` only when a send actually succeeded — gate any
 * "notify once" dedup state (e.g. `last_notified_at`) on this, never on
 * "a subscription existed when this call started". A transient failure
 * (network blip, 429, 5xx — anything that isn't 404/410) must not
 * permanently mark a notification as sent when nothing was ever
 * delivered.
 */
export async function sendPushToAll(
  pool: pg.Pool,
  subs: PushSubRow[],
  payload: PushPayload
): Promise<SendPushToAllResult> {
  let delivered = false;
  let sent = 0;
  let removed = 0;
  for (let i = subs.length - 1; i >= 0; i--) {
    const sub = subs[i];
    const result = await sendPush(
      { id: sub.id, userId: sub.user_id, endpoint: sub.endpoint, keys: sub.keys_json },
      payload
    );
    if (result.ok) {
      sent++;
      delivered = true;
    } else if (result.shouldRemove) {
      try {
        await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [sub.id]);
        removed++;
      } catch (err) {
        console.error(`sendPushToAll: failed to delete stale push subscription ${sub.id}`, err);
      }
      subs.splice(i, 1);
    }
  }
  return { delivered, sent, removed };
}
