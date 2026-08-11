# Contributing

`main` is protected — changes land through a pull request, not a direct
push.

## Workflow

1. Branch off `main`: `git checkout -b your-branch-name`.
2. Make your change.
3. Before opening a PR, run locally:
   ```
   npm run typecheck
   npm run lint
   npm run test
   npm run vercel-build
   npm run test:e2e --workspace=apps/web   # optional locally, runs in CI regardless
   ```
4. Open a PR into `main`. GitHub Actions (`.github/workflows/ci.yml`) runs
   five required checks: `typecheck`, `lint`, `unit-tests`, `build`, and
   `integration-tests` (the last one exercises `api/` handlers against a
   throwaway Postgres container — see `api/*.integration.test.ts`). All
   five must pass before the PR can merge. A sixth job, `e2e-tests`
   (Playwright), also runs on every PR but isn't required yet — see
   "Tests" below.
5. Merge once green. No second approver is required (solo-maintained
   repo) — the PR + passing-checks requirement is what's enforced.

## Tests

- Unit tests (`*.test.ts`, colocated next to the source file, run via
  `npm run test`) cover pure logic — `packages/shared` (period derivation,
  anomaly detection), `packages/server-lib` (auth) — and, as of
  2026-08-11, React Testing Library coverage for every `apps/web/src/routes/*`
  page (`*.test.tsx`, same directory) plus `apps/web/src/sync/engine.ts`
  (push/pull conflict resolution). Route tests seed Dexie directly via
  `fake-indexeddb` (see `apps/web/src/test/fixtures.ts`) rather than
  mounting the sync engine, since the app is local-first and every route
  reads/writes Dexie synchronously — network only enters via `authFetch`,
  which is mocked per-file the same way `sync/engine.test.ts` already did.
- Integration tests (`api/**/*.integration.test.ts`, run via
  `npm run test:integration --workspace=api`) call the Vercel Function
  handlers directly against a real Postgres, migrated fresh each run.
  They need `DATABASE_URL` (+ `JWT_SECRET`) pointed at a disposable
  database — never point this at a real Neon branch.
- End-to-end (`apps/web/e2e/*.spec.ts`, Playwright, run via
  `npm run test:e2e --workspace=apps/web`) drives the actual built app in
  a real browser via `vite dev` + Playwright's `page.route` interception
  as the mock-API harness described in `apps/web/playwright.config.ts` —
  no real Postgres/Blob/VAPID deployment needed, since every `/api/**`
  call is intercepted before it leaves the browser and the app itself is
  local-first (Dexie-backed) for everything except login and anomalies.
  The Playwright browser binary isn't part of `npm ci`; run
  `npx playwright install chromium` once locally before `test:e2e` (CI
  does this itself, with `--with-deps`, in the `e2e-tests` job). Not yet
  promoted to a required check — see the CI workflow's comment on that
  job for the bar to clear first.
