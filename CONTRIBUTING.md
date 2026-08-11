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
   ```
4. Open a PR into `main`. GitHub Actions (`.github/workflows/ci.yml`) runs
   five required checks: `typecheck`, `lint`, `unit-tests`, `build`, and
   `integration-tests` (the last one exercises `api/` handlers against a
   throwaway Postgres container — see `api/*.integration.test.ts`). All
   five must pass before the PR can merge.
5. Merge once green. No second approver is required (solo-maintained
   repo) — the PR + passing-checks requirement is what's enforced.

## Tests

- Unit tests (`*.test.ts`, colocated next to the source file, run via
  `npm run test`) cover pure logic: `packages/shared` (period derivation,
  anomaly detection), `packages/server-lib` (auth), and
  `apps/web/src/sync/engine.ts` (push/pull conflict resolution).
- Integration tests (`api/**/*.integration.test.ts`, run via
  `npm run test:integration --workspace=api`) call the Vercel Function
  handlers directly against a real Postgres, migrated fresh each run.
  They need `DATABASE_URL` (+ `JWT_SECRET`) pointed at a disposable
  database — never point this at a real Neon branch.
- End-to-end (Playwright, driving the actual PWA) isn't set up yet — see
  the CI workflow's comments for why, and treat it as follow-up work.
