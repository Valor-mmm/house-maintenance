import { type Reading, type ReadingCreateInput, type ExifMetadata } from "@house/shared";
import { db } from "../db/dexie";
import { enqueueForSync } from "../sync/engine";

/**
 * Local write helpers for readings (see docs/sync-design.md and
 * packages/shared/src/reading.ts). `photoBlobUrl` is deliberately never
 * settable here — it is written only via `attachPhoto` in
 * ../sync/engine.ts, per the dedicated photo-attach path documented in
 * docs/sync-design.md. Mirrors the `updatedAt` sentinel convention in
 * ../data/tasks.ts and ../data/meters.ts: new rows get a placeholder
 * that's only ever visible on this device until the next push/pull
 * round-trip overwrites it with the server-assigned value.
 */
const UNSYNCED_UPDATED_AT = new Date(0).toISOString();

export type CreateReadingInput = Omit<
  ReadingCreateInput,
  "id" | "clientEditedAt" | "photoBlobUrl"
>;

export async function createReading(input: CreateReadingInput): Promise<Reading> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const reading: Reading = {
    id,
    meterId: input.meterId,
    value: input.value,
    capturedAt: input.capturedAt,
    note: input.note ?? null,
    photoExif: input.photoExif ?? null,
    photoBlobUrl: null,
    clientEditedAt: now,
    updatedAt: UNSYNCED_UPDATED_AT,
    deletedAt: null,
  };
  await db.transaction("rw", db.readings, db.outbox, async () => {
    await db.readings.add(reading);
    await enqueueForSync("readings", id);
  });
  return reading;
}

export interface EditReadingInput {
  value?: number;
  capturedAt?: string;
  note?: string | null;
  photoExif?: ExifMetadata | null;
}

/**
 * Edits a reading's note/value/capturedAt (and EXIF metadata alongside a
 * value/capturedAt correction). Never touches `photoBlobUrl` — see the
 * module doc comment. Leaves the row's existing `updatedAt` as-is (the
 * server reassigns it on the next push regardless of what's stored
 * locally); only `clientEditedAt` — audit/UX display only, never used
 * for sync ordering — is refreshed here.
 */
export async function editReading(id: string, patch: EditReadingInput): Promise<Reading> {
  const existing = await db.readings.get(id);
  if (!existing || existing.deletedAt) {
    throw new Error(`editReading: no reading with id ${id}`);
  }
  const updated: Reading = {
    ...existing,
    value: patch.value ?? existing.value,
    capturedAt: patch.capturedAt ?? existing.capturedAt,
    note: patch.note !== undefined ? patch.note : existing.note,
    photoExif: patch.photoExif !== undefined ? patch.photoExif : existing.photoExif,
    clientEditedAt: new Date().toISOString(),
  };
  await db.transaction("rw", db.readings, db.outbox, async () => {
    await db.readings.put(updated);
    await enqueueForSync("readings", id);
  });
  return updated;
}

export async function deleteReading(id: string): Promise<void> {
  const existing = await db.readings.get(id);
  if (!existing || existing.deletedAt) return;
  const updated: Reading = { ...existing, deletedAt: new Date().toISOString() };
  await db.transaction("rw", db.readings, db.outbox, async () => {
    await db.readings.put(updated);
    await enqueueForSync("readings", id);
  });
}
