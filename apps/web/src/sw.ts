/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import {
  buildNotificationOptions,
  parsePushPayload,
  resolveNotificationUrl,
} from "./sw-notification";

/**
 * The app's service worker.
 *
 * This file exists because VitePWA's `generateSW` mode — what this
 * project used until now — emits a Workbox service worker with no `push`
 * or `notificationclick` handler at all. The server has been sending
 * real Web Push messages the whole time (api/cron.ts -> sendPushToAll),
 * but with nothing listening, Chrome substituted its own generic "this
 * site was updated in the background" notification and a tap did
 * nothing. Every notification the app sends was affected, not just new
 * ones. Hence `injectManifest`: the precaching below reproduces what
 * `generateSW` did for us, and the two handlers at the bottom are the
 * actual point of the file.
 *
 * `self` is redeclared rather than imported: this file is a module, so
 * the declaration is module-scoped and just narrows the ambient
 * `WorkerGlobalScope` to the service-worker flavour. `__WB_MANIFEST` is
 * the placeholder vite-plugin-pwa replaces with the precache manifest at
 * build time — it must be referenced exactly once, or the build fails.
 */
declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

// Matches the previous `registerType: "autoUpdate"` behaviour: a new
// worker takes over immediately instead of waiting for every tab to
// close. Safe here because the app's data layer is Dexie, not the
// service worker cache (docs/sync-design.md) — a swap mid-session can't
// strand half-written state.
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// The `navigateFallback: "/index.html"` from the old workbox config:
// client-side routes have no server-side counterpart, so every
// navigation is served the precached app shell. `/api/` is excluded —
// those are real server requests and must never be answered from the
// shell (vercel.json's rewrite rule draws the same line).
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//],
  })
);

self.addEventListener("push", (event) => {
  const payload = parsePushPayload(event.data?.text());
  // waitUntil so the worker isn't torn down before the notification is
  // actually shown.
  event.waitUntil(
    self.registration.showNotification(payload.title, buildNotificationOptions(payload))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openApp(resolveNotificationUrl(event.notification.data)));
});

/**
 * Focuses an existing app window and navigates it to `path`, or opens a
 * new one. Reusing a window matters on Android: the PWA is typically
 * already open in the background, and `openWindow` would leave a second,
 * separate instance behind.
 */
async function openApp(path: string): Promise<void> {
  const target = new URL(path, self.location.origin);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

  for (const client of windows) {
    if (new URL(client.url).origin !== target.origin) continue;
    await client.focus();
    if (new URL(client.url).pathname === target.pathname) return;
    try {
      await client.navigate(target.href);
      return;
    } catch {
      // navigate() rejects for a window this worker doesn't control
      // (e.g. one loaded before the worker activated) — fall through and
      // open a fresh one rather than leaving the tap with no effect.
      break;
    }
  }

  await self.clients.openWindow(target.href);
}
