# House Maintenance

**A field instrument for the house you live in.**

A local-first Progressive Web App for tracking utility meter readings —
electricity in/out, water, pressure gauges — and the recurring maintenance
tasks that keep a house running. Log a reading offline in the basement
with no signal, and it's there waiting to sync the moment you're back
online. No spreadsheet, no forgetting when the boiler was last serviced,
no guessing whether this month's electricity bill is normal or an
anomaly worth investigating.

Built as a real production app for a real house, not a demo — see
[`docs/sync-design.md`](docs/sync-design.md) and
[`docs/period-derivation.md`](docs/period-derivation.md) for the two
pieces of this system that are easy to get subtly wrong, worked through
in full.

![TypeScript](https://img.shields.io/badge/TypeScript-blue?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-149eca?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-B73BFE?logo=vite&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8)
![Postgres](https://img.shields.io/badge/Postgres-Neon-336791?logo=postgresql&logoColor=white)
![Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?logo=vercel&logoColor=white)

## What it does

- **Meter tracking** — electricity in/out, water, pressure gauges, or any
  custom meter, each on its own reading schedule. Group meters together
  (e.g. two solar inverters feeding one net figure) with signed
  in/out/other roles.
- **Consumption anomaly detection** — a nightly sweep compares each
  meter's latest period against its own trailing baseline and flags
  anything meaningfully off-trend, so a leaking pipe or a stuck heater
  shows up before the bill does.
- **Maintenance tasks** — recurring tasks with due dates, completion
  notes, and cost tracking.
- **Photo capture with EXIF** — attach a photo to any reading straight
  from the camera; capture time and GPS are pulled from EXIF when
  present, uploaded directly to object storage from the browser.
- **Push notifications** — overdue tasks, due readings, and anomalies
  reach you as real Web Push notifications, not just an in-app badge.
- **Offline-first, always** — Dexie/IndexedDB is the source of truth on
  the device; a background sync engine reconciles with the server using
  a conflict model designed for one person's multiple devices, not a
  naive "last write wins."
- **Backups, automated and manual** — a weekly snapshot of the entire
  dataset and every photo, plus an on-demand "back up now," restorable
  even from an archive saved outside the deployment entirely (e.g. a
  copy you keep on your own cloud storage) — real disaster recovery, not
  just a database in one place.

## Design

The interface follows a deliberate "field instrument" aesthetic — hairline
borders instead of shadows, tabular numerals, a single confident accent
color, restrained status colors — meant to read like a well-made analog
meter rather than another SaaS dashboard. See `apps/web/src/index.css`
for the full token set.

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
docs/            sync-design.md, period-derivation.md, deployment.md —
                  the specs implementation must follow exactly, since
                  they're each easy to reimplement slightly differently
                  in two places if only described in prose.
```

## Stack

- **Frontend** — Vite + React + TypeScript, `vite-plugin-pwa`, Dexie.js
  (IndexedDB, local-first source of truth), Recharts, exifr.
- **Backend** — Vercel Functions (Node.js runtime — required for the
  `web-push` package), Neon Postgres (`@neondatabase/serverless`), Vercel
  Blob (direct browser-to-Blob upload for photos and backup archives),
  Vercel Cron (daily notification sweep + weekly backup).
- **Auth** — username/password with `scrypt` hashing, JWT session in an httpOnly cookie.
  Single-household app by design; see `docs/sync-design.md` for what that
  does and doesn't simplify.

## Local dev

```
npm install
npm run dev:web        # frontend against a local/dev Neon branch
vercel dev             # api/ functions locally (requires `vercel link` first)
```

See [`docs/deployment.md`](docs/deployment.md) for a full walkthrough of
standing up your own instance — Neon Postgres, Vercel Blob, VAPID keys,
and the cron/env-var wiring, end to end.

## Contributing

`main` is protected — changes go through a PR with required CI checks
(typecheck, lint, unit tests, build, integration tests). See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the branch/PR workflow and what
each check covers.
