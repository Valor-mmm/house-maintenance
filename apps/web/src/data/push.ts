import { authFetch } from "../auth/token";

/**
 * Web Push subscription flow: request Notification permission, wait for
 * the service worker to be ready, subscribe via the Push API, then hand
 * the resulting subscription to the server (POST /api/push/subscribe) so
 * the daily cron (api/cron/daily-sweep.ts) can send to it.
 *
 * `push_subscriptions` is server-authoritative (see docs/sync-design.md)
 * — nothing here touches Dexie.
 */

export type EnablePushResult = { ok: true } | { ok: false; reason: string };

/** VAPID public key, base64url-encoded, -> the raw bytes the Push API wants. */
function urlBase64ToUint8Array(base64String: string): BufferSource {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  // TS's dom lib types Uint8Array as generic over its buffer in recent
  // versions, which doesn't structurally satisfy BufferSource/PushManager's
  // applicationServerKey param without this cast — the runtime value is a
  // plain Uint8Array backed by a real ArrayBuffer either way.
  return outputArray.buffer as ArrayBuffer;
}

/**
 * Requests permission and registers a push subscription with the server.
 * Guards against every piece of this being unavailable (unsupported
 * browser, permission denied, missing VAPID key — the key isn't set in
 * this dev environment and won't be until deployment) rather than
 * throwing/crashing the caller.
 */
export async function enablePushNotifications(): Promise<EnablePushResult> {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, reason: "Push notifications aren't supported in this browser." };
  }

  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) {
    return { ok: false, reason: "Push notifications aren't configured on this deployment yet." };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "Notification permission was not granted." };
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return { ok: false, reason: "Browser returned an incomplete push subscription." };
  }

  const res = await authFetch("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    }),
  });
  if (!res.ok) {
    return { ok: false, reason: `Failed to register subscription with the server (${res.status}).` };
  }

  return { ok: true };
}
