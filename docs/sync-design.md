# Sync design

Single source of truth for how the offline-first client (Dexie/IndexedDB)
reconciles with the server (Neon Postgres via `api/sync/*`). Every
implementer — human or subagent — should follow this exactly rather than
re-deriving it; the plan this repo was built from specifically calls out
sync as the piece most likely to be subtly reimplemented two different
ways if only described in prose once.

## Which tables sync, which don't

**Syncable** (offline-editable, go through the push/pull engine below):
`meters`, `meterGroups`, `meterGroupMembers`, `meterEvents`, `readings`,
`taskTemplates`, `taskInstances`. Schemas: `packages/shared/src/{meter,
reading,task}.ts`. Envelope types: `packages/shared/src/sync.ts`.

**Server-authoritative** (fetched directly when online, not offline-edited,
no sync metadata): `users`, `properties`, `propertyMembers`,
`anomalyFlags`, `pushSubscriptions`. These rarely change (properties/
membership) or are computed/managed server-side (anomaly flags, push
subscriptions) — there's nothing for the client to create offline.

## Sync metadata

Every syncable row has:
- `id` — **client-generated UUID**. Generated at creation time (including
  offline) so a row created offline has a stable identity before it ever
  reaches the server; the server never issues IDs.
- `updatedAt` — **assigned by the server on ingestion, always**. Never
  read a client-supplied `updatedAt`, never derive it from `Date.now()` on
  the device. A phone with a wrong or fast clock must not be able to beat
  a genuinely later laptop edit — that's a real corruption vector, not a
  theoretical one, since phone clocks routinely drift.
- `deletedAt` — soft-delete tombstone, nullable.

`readings` additionally has `clientEditedAt` — the client's own
timestamp, kept **only** for audit/UX display ("edited 3 minutes ago"). It
must never be used for sync ordering or conflict resolution.

## Sync cursor

A pull cursor is the compound pair `{ updatedAt, id }`
(`packages/shared/src/sync.ts` → `syncCursorSchema`), not a bare
timestamp. Two rows updated in the same millisecond under a bare-timestamp
`WHERE updated_at > watermark` comparison can silently skip one of them on
the next pull; the compound cursor with a stable tiebreaker (`id`) avoids
that.

The client **stores exactly what the server echoes back** as
`nextCursor` in a pull response — it never computes a watermark locally
from the rows it received.

## Push flow

Client → `POST /api/sync/push { table, rows }`:
1. For each row: if `id` is new to the server, insert it; if it already
   exists, this is an edit — go to the merge rule below.
2. The server assigns `updatedAt = now()` on write, ignoring any
   `updatedAt` the client might have sent (there shouldn't be one — the
   create/edit input schemas in `packages/shared` don't include it).
3. Respond with the list of accepted row IDs.

## Pull flow

Client → `POST /api/sync/pull { table, cursor }`:
1. Server returns rows for that table with `(updatedAt, id) > cursor`,
   ordered the same way, up to a page size, plus `nextCursor` (the cursor
   of the last row in the page, or unchanged if `hasMore` is false) and
   `hasMore`.
2. Client merges each row into Dexie per the merge rule below, then
   stores `nextCursor` as its new watermark for that table.
3. Client repeats while `hasMore` is true.

## Merge rule: last-write-wins by server `updatedAt`

When a pulled row's `id` already exists locally, the row with the greater
`updatedAt` (server-assigned) wins, wholesale, **except**:

- **Delete is terminal.** If either the local or the incoming row has a
  non-null `deletedAt`, the tombstone wins regardless of which side has
  the greater `updatedAt`. A later-timestamped edit does not resurrect a
  deleted row. (Restoring a deleted record is a deliberate future action,
  not an implicit side effect of sync — parking lot.)
- **Photo attachment is never part of whole-row LWW.** See below.

This is a documented v1 simplification: it's sound for one person syncing
across their own two devices, where real conflicting edits are rare. It
is **not** a general multi-user CRDT — if household sharing is ever added,
revisit this section first.

## Photo attach: a dedicated path, not a row field race

Sequence this must handle correctly: a reading is created and synced with
`photoBlobUrl = null` (the photo is still uploading in the background) →
the user edits the reading's note on a different device → the photo
upload finishes and the app needs to write `photoBlobUrl` onto that same
row. Under plain whole-row LWW, whichever write has the later `updatedAt`
wins *entirely* — so either the note edit is lost, or the photo URL never
gets attached, and which one happens is a race, not a decision.

Fix: `photoBlobUrl` is **never written by the generic push/merge path** —
neither the create/edit payload the client pushes for a reading, nor the
whole-row winner picked during pull-merge, ever sets it. It is written
only via a narrow, dedicated endpoint — `POST /api/readings/:id/photo`
(payload: `readingPhotoAttachInputSchema` in
`packages/shared/src/reading.ts`) — that does a targeted
`UPDATE readings SET photo_blob_url = $1, updated_at = now() WHERE id = $2`.

That endpoint **does** bump `updated_at` — it has to, otherwise the row
would never be re-selected by a future `(updated_at, id) > cursor` pull on
another device, and the photo would never propagate at all. What it does
*not* do is let that bump cause a whole-row overwrite: on pull-merge, a
reading's `photoBlobUrl` is resolved **independently** of the rest of the
row — always take whichever side has a non-null value, server winning
ties — while every other field still follows the normal LWW-by-`updatedAt`
rule above, keyed off that same `updatedAt`. So the attach's `updated_at`
bump correctly makes the row "visible" to the next pull without giving
the photo write any power to clobber an unrelated concurrent field edit
on that row — the two are merged on separate axes, not as one wholesale
winner-take-all row.

Client-side, the photo upload itself goes **directly from the browser to
Vercel Blob** (`@vercel/blob/client` signed-upload flow) — not through
this API — and only the resulting URL is sent to the attach endpoint.
This also sidesteps Vercel Functions' 4.5MB request body limit, which a
full-resolution phone photo can easily exceed.

## Clock skew & timezones

Because `updatedAt` is server-assigned, client clock skew cannot corrupt
sync ordering. `capturedAt` (when a reading was actually taken) is a
separate, user/EXIF-sourced field and is never used as a sync ordering
key — it can legitimately be backdated (e.g. entering a reading from a
photo taken earlier) without affecting merge behavior.

## Worked conflict scenarios (for tests)

1. **Concurrent edit, same device offline twice**: edit A at local time
   T1, edit B at local time T2 > T1, both made offline, both pushed on
   reconnect in the same push batch. Server assigns `updatedAt` in
   receipt order — whichever the client happened to send last in the
   batch wins. Client should send rows in the order they were made
   locally to keep this intuitive, but the plan doesn't guarantee
   causal ordering across devices, only within one push batch.
2. **Edit vs. delete race**: reading edited on phone (offline), same
   reading deleted on laptop (offline), both reconnect in either order.
   Regardless of `updatedAt` ordering, the tombstone wins (see Merge
   rule) — the reading ends up deleted.
3. **Photo attach after an unrelated edit**: see "Photo attach" above —
   both the note edit and the photo URL survive, because they're
   different write paths.
