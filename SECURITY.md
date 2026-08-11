# Security

This is a personal, single-household project — not a commercial product
with an SLA — but it's public, so here's the honest state of things.

## Reporting an issue

Open a GitHub issue, or a private security advisory if it's something
that shouldn't be public until fixed. There's no dedicated
security contact beyond that.

## Threat model

Single-user auth (username/password, `scrypt`-hashed, 30-day JWT session
in an httpOnly cookie). One household, one property, seeded by
`db/migrations/006_seed.sql`. `docs/sync-design.md` states this
explicitly: the sync/merge model is "sound for one person syncing across
their own two devices... not a general multi-user CRDT." Endpoints don't
scope queries by user/property because there's only ever been one of
each — if household sharing or multi-tenancy is ever added, that
assumption needs revisiting first, everywhere, not endpoint-by-endpoint.

## What's already in place

- Every data-touching endpoint requires a valid session (`api/_lib/http.ts`'s
  `requireSession`, reading the `session` cookie); cron endpoints require a
  separate `CRON_SECRET` bearer token instead. All SQL is parameterized —
  no string-interpolated user input anywhere.
- The session token lives only in an httpOnly, `SameSite=Strict` cookie
  (`api/auth/login.ts` sets it, `api/auth/logout.ts` clears it) — never in
  a JS-readable response body or `localStorage`, so an XSS bug can't
  exfiltrate it by reading `document.cookie`. A second, non-httpOnly
  `session_present` cookie carries no secret and exists purely so
  client-side route guards (`apps/web/src/auth/token.ts`'s `hasSession()`)
  can stay a synchronous check instead of pinging the server on every
  navigation. `SameSite=Strict` was chosen over a CSRF token because the
  app has no cross-origin state-changing entry points to begin with (no
  third-party embeds, no OAuth-style redirect-back flows) — it closes the
  gap without extra machinery.
- Login has a basic per-username lockout (`db/migrations/008_login_lockout.sql`):
  5 failed attempts locks the account for 15 minutes.
- Secrets (`JWT_SECRET`, `CRON_SECRET`, VAPID keys, `DATABASE_URL`,
  `BLOB_READ_WRITE_TOKEN`) are read only from environment variables, never
  hardcoded, and `.env*` is git-ignored.
- The backup/restore feature (`api/backup.ts`, `packages/server-lib/src/backup.ts`)
  went through a dedicated review: the restore endpoint's archive-source
  URL is allowlisted to this project's own Blob storage host and prefixes
  (not an open fetch of any URL an attacker could supply), with a 200MB
  streamed size cap; the photo-restore path validates the archive's
  reading-id shape before use.
- Response security headers are set on every route in `vercel.json`:
  a `Content-Security-Policy` (script-src restricted to `'self'`; the
  theme-flash-prevention script lives at `public/theme-init.js` rather
  than inline, specifically so CSP doesn't need a content hash),
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and
  `Strict-Transport-Security`. With the session token no longer
  JS-readable (see above), CSP's script-src restriction is defense-in-depth
  against a wider class of injected-script mischief, rather than the one
  thing standing between an XSS bug and session theft.

## Accepted dependency debt

`npm audit` currently reports issues in three transitive dependencies.
Each was evaluated for actual exploitability in this app's usage, not
just taken at face value from its severity label:

- **`react-router`/`react-router-dom`** (moderate — open redirect,
  SSR-hydration constructor injection): this app is a pure client-rendered
  SPA, no SSR, so the hydration issue doesn't apply; there's no
  attacker-controlled redirect target anywhere in the app's routing. No
  non-breaking fix exists on the 6.x line — only 7.x, a major version.
  Deferred until an opportunistic migration.
- **`undici`** (high, via `@vercel/blob`): used only as an outbound HTTP
  client to Vercel's own Blob API, never as a server parsing untrusted
  upstream traffic — the issues that matter here (request smuggling,
  response-queue poisoning) require the vulnerable party to be the one
  receiving untrusted requests. Deferred; revisit when `@vercel/blob`
  ships a non-breaking patched line.
- **`node-tar`** (critical, nested under `@vercel/node`): a
  build/dev-time-only dependency, never part of the deployed Vercel
  Function runtime. Not reachable by anything this app does at runtime.

None of these were left un-investigated — each was traced to its actual
call site (or lack thereof) in this codebase before being deferred.
