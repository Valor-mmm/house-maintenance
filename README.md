# House Maintenance

Local-first PWA for tracking utility meter readings (electricity in/out,
water, pressure gauges) and recurring house maintenance tasks. See
`docs/sync-design.md` and `docs/period-derivation.md` for the two pieces of
this system that are easy to get subtly wrong.

## Layout

```
api/             Vercel Functions (Node.js runtime) — the backend.
                 Lives at repo root (not apps/api) because Vercel's
                 zero-config serverless functions must sit in /api at the
                 project's Root Directory. Deployed as part of the same
                 Vercel project as apps/web, on the same custom domain —
                 same-origin, no CORS, one deploy.
apps/web/        React + TypeScript + Vite PWA frontend.
packages/shared/ Zod schemas + TS types shared by api/ and apps/web.
db/migrations/   SQL migrations for the Neon Postgres database.
docs/            sync-design.md, period-derivation.md — the two specs
                 implementation must follow exactly, since both are easy
                 to reimplement slightly differently in two places if
                 only described in prose.
```

## Stack

- Frontend: Vite + React + TypeScript, `vite-plugin-pwa`, Dexie.js
  (IndexedDB, local-first source of truth), Recharts, exifr.
- Backend: Vercel Functions (Node.js runtime — required for the `web-push`
  package), Neon Postgres (`@neondatabase/serverless`), Vercel Blob
  (direct browser-to-Blob upload for photos), Vercel Cron (daily sweep).
- Deployed on the existing Vercel account/custom domain.

## Local dev

```
npm install
npm run dev:web        # frontend against a local/dev Neon branch
vercel dev             # api/ functions locally (requires `vercel link` first)
```
