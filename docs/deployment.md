# Deployment

This app deploys as a single Vercel project (repo root as the Root
Directory — `apps/web` builds to static output, `/api` is picked up as
Vercel Functions automatically). It needs accounts/credentials only you
can provide, so this is a manual walkthrough rather than something
automated.

## 1. Neon Postgres

1. In your Vercel dashboard: **Storage → Create Database → Neon
   (Postgres)** (or create a project directly at neon.tech and connect it
   to Vercel via the Neon integration — either path works).
2. Copy the **pooled** connection string (has `-pooler` in the hostname —
   see `packages/server-lib/src/db.ts` for why the direct one won't work
   correctly here). Put it in `.env` as `DATABASE_URL` for the migration
   steps below, and also add it as a Vercel project environment variable
   (Production **and** Preview).

## 2. Vercel Blob

1. **Storage → Create → Blob**.
2. This automatically sets `BLOB_READ_WRITE_TOKEN` as a project env var —
   copy the same value into your local `.env` too (needed if you ever run
   `vercel dev` locally against real Blob).

## 3. Environment variables

`.env` already has `JWT_SECRET`, `CRON_SECRET`, and a generated VAPID
keypair filled in (see `.env.example` for what each does — do not commit
`.env`, it's git-ignored). Set all of these as Vercel project environment
variables (Production **and** Preview):

- `DATABASE_URL` (from step 1)
- `BLOB_READ_WRITE_TOKEN` (from step 2)
- `JWT_SECRET`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (replace the
  placeholder email in `VAPID_SUBJECT` with a real address you control —
  push services may use it to contact you about key usage)
- `VITE_VAPID_PUBLIC_KEY` (same value as `VAPID_PUBLIC_KEY` — needs the
  `VITE_` prefix separately because Vite only exposes `VITE_`-prefixed
  vars to the browser bundle)
- `CRON_SECRET`

## 4. Apply the database schema

With `DATABASE_URL` filled in in your local `.env`:

```
npm run db:migrate
```

Then create your login (pick your own username/password):

```
HOUSE_USERNAME=yourname HOUSE_PASSWORD='a real passphrase' node --env-file=.env db/seed-user.mjs
```

## 5. Link and deploy

```
vercel login          # opens a browser, needs your Vercel account
vercel link            # connects this repo to a Vercel project
vercel env pull .env.vercel   # sanity-check the env vars landed (optional)
vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard for auto-deploy on
push, if you'd rather not deploy from the CLI each time.

## 6. Custom domain

**Project Settings → Domains** — add your existing domain (the whole
reason for choosing Vercel was reusing what's already there). Same-origin
frontend + API is required for the service worker/push to work correctly,
which this setup gives you automatically.

## 7. Verify

- Visit the deployed URL, log in with the credentials from step 4.
- Install the PWA (Android: Chrome should offer the install banner built
  in `App.tsx`'s `InstallBanner`).
- Enable notifications from the dashboard.
- Manually trigger a cron run to test end-to-end without waiting for
  06:00 UTC. Both jobs live behind one consolidated endpoint
  (`api/cron.ts` — see its top-of-file comment for why), disambiguated by
  a `?job=` query param when triggered manually like this (Vercel's own
  scheduled invocations disambiguate via an `x-vercel-cron-schedule`
  header instead, set automatically, nothing to configure):
  ```
  curl -X POST "https://<your-domain>/api/cron?job=sweep" \
    -H "Authorization: Bearer $CRON_SECRET"
  ```
  Check the JSON summary it returns, and confirm a real push notification
  arrives on your phone.
- Same for the weekly backup job (see the Backups page in the app for the
  manual/restore side of this feature):
  ```
  curl -X POST "https://<your-domain>/api/cron?job=backup" \
    -H "Authorization: Bearer $CRON_SECRET"
  ```
  Confirm it returns `"ok": true` and a new row shows up on `/backups`.
- Go offline (airplane mode), log a reading or complete a task, go back
  online, confirm it syncs (check `db/migrate`'d Postgres directly, or
  just reload on a second device/browser profile logged in with the same
  account).
