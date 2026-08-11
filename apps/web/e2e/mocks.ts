import type { Page } from "@playwright/test";

/**
 * The mock-API harness: intercepts every `/api/**` call at the browser
 * network layer so specs never need a real Postgres/Blob/VAPID-backed
 * deployment. `vite dev`'s `/api` proxy target (see vite.config.ts) is
 * never reached — Playwright's route interception happens before the
 * request leaves the browser.
 */

const FAKE_USER = { id: "00000000-0000-0000-0000-0000000000e2", username: "e2e-user" };
// The real session lives in an httpOnly cookie the app never reads from JS
// (see apps/web/src/auth/token.ts) — client-side route guards only check
// this non-secret marker, so it's the only piece these mocks need to fake.
// Unlike the old localStorage+addInitScript approach, a real cookie added
// via addCookies() doesn't get re-injected on every navigation, so it
// behaves exactly like a genuine session for reload/logout specs alike.
const SESSION_MARKER_COOKIE = "session_present";

/** Sets the session marker directly, bypassing the login form for specs that don't test login itself. */
export async function signInDirectly(page: Page): Promise<void> {
  await page.context().addCookies([
    { name: SESSION_MARKER_COOKIE, value: "1", domain: "localhost", path: "/" },
  ]);
}

/** Empty push/pull for every table — the app is local-first, so an empty sync round-trip is indistinguishable from a real server with nothing new to offer. */
export async function mockSync(page: Page): Promise<void> {
  await page.route("**/api/sync**", async (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get("action");
    if (action === "push") {
      const body = route.request().postDataJSON() as { rows: { id: string }[] };
      await route.fulfill({ json: { accepted: body.rows.map((r) => r.id) } });
      return;
    }
    if (action === "pull") {
      await route.fulfill({ json: { rows: [], nextCursor: null, hasMore: false } });
      return;
    }
    await route.fulfill({ status: 400, json: { error: "unknown sync action" } });
  });
}

export async function mockAnomalies(page: Page, anomalies: unknown[] = []): Promise<void> {
  await page.route("**/api/anomalies", (route) => route.fulfill({ json: anomalies }));
}

export async function mockBackups(page: Page, backups: unknown[] = []): Promise<void> {
  await page.route("**/api/backup", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: backups });
    }
    return route.fulfill({ status: 501, json: { error: "not mocked" } });
  });
}

export async function mockLoginSuccess(page: Page): Promise<void> {
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      json: { user: FAKE_USER },
      headers: { "set-cookie": `${SESSION_MARKER_COOKIE}=1; Path=/` },
    })
  );
}

export async function mockLoginFailure(page: Page, message = "Invalid username or password."): Promise<void> {
  await page.route("**/api/auth/login", (route) => route.fulfill({ status: 401, json: { error: message } }));
}

export async function mockLogout(page: Page): Promise<void> {
  await page.route("**/api/auth/logout", (route) => route.fulfill({ status: 204 }));
}

/** Full harness for specs that just need to land on an authenticated page and not error. */
export async function mockAuthenticatedSession(page: Page): Promise<void> {
  await signInDirectly(page);
  await mockSync(page);
  await mockAnomalies(page);
  await mockBackups(page);
  await mockLogout(page);
}
