import {
  SYNCABLE_TABLES,
  type SyncableTable,
  type SyncCursor,
} from "@house/shared";
import { db, tableFor } from "../db/dexie";
import { authFetch } from "../auth/token";

/**
 * Client half of docs/sync-design.md. Feature-slice code must never write
 * directly to the server for a syncable table — it writes to Dexie and
 * calls `enqueueForSync`, and this engine reconciles with the server.
 */

export async function enqueueForSync(table: SyncableTable, rowId: string): Promise<void> {
  await db.outbox.add({ table, rowId, queuedAt: new Date().toISOString() });
}

async function pushTable(table: SyncableTable): Promise<void> {
  const entries = await db.outbox.where("table").equals(table).toArray();
  if (entries.length === 0) return;

  const dexieTable = tableFor(table);
  const rowIds = [...new Set(entries.map((e) => e.rowId))];
  const rows = (await dexieTable.bulkGet(rowIds)).filter((r) => r != null);
  if (rows.length === 0) {
    await db.outbox.bulkDelete(entries.map((e) => e.id!));
    return;
  }

  const res = await authFetch("/api/sync/push", {
    method: "POST",
    body: JSON.stringify({ table, rows }),
  });
  if (!res.ok) return; // stays in the outbox, retried on the next sync pass

  const body = (await res.json()) as { accepted: string[] };
  const accepted = new Set(body.accepted);
  const toRemove = entries.filter((e) => accepted.has(e.rowId)).map((e) => e.id!);
  await db.outbox.bulkDelete(toRemove);
}

/**
 * Delete is terminal; otherwise last-write-wins by server-assigned
 * updatedAt — EXCEPT `photoBlobUrl` on readings, which is merged on its
 * own axis (whichever side has a non-null value, server winning ties) so
 * the attach endpoint's updatedAt bump can make a row visible to future
 * pulls without also giving it power to clobber an unrelated concurrent
 * field edit. See docs/sync-design.md "Photo attach".
 */
function pickWinner(table: SyncableTable, existing: any, incoming: any): any {
  const existingDeleted = existing.deletedAt != null;
  const incomingDeleted = incoming.deletedAt != null;
  const winner = existingDeleted || incomingDeleted
    ? (incomingDeleted ? incoming : existing)
    : (incoming.updatedAt > existing.updatedAt ? incoming : existing);

  if (table === "readings") {
    const photoBlobUrl = incoming.photoBlobUrl ?? existing.photoBlobUrl ?? null;
    if (winner.photoBlobUrl !== photoBlobUrl) return { ...winner, photoBlobUrl };
  }
  return winner;
}

async function pullTable(table: SyncableTable): Promise<void> {
  const dexieTable = tableFor(table);
  const cursorRecord = await db.syncCursors.get(table);
  let cursor: SyncCursor | null = cursorRecord
    ? { updatedAt: cursorRecord.updatedAt, id: cursorRecord.id }
    : null;

  let hasMore = true;
  while (hasMore) {
    const res = await authFetch("/api/sync/pull", {
      method: "POST",
      body: JSON.stringify({ table, cursor }),
    });
    if (!res.ok) return;

    const body = (await res.json()) as {
      rows: any[];
      nextCursor: SyncCursor | null;
      hasMore: boolean;
    };

    if (body.rows.length > 0) {
      await db.transaction("rw", dexieTable, async () => {
        for (const incoming of body.rows) {
          const existing = await dexieTable.get(incoming.id);
          await dexieTable.put(existing ? pickWinner(table, existing, incoming) : incoming);
        }
      });
    }

    if (body.nextCursor) {
      await db.syncCursors.put({ table, ...body.nextCursor });
      cursor = body.nextCursor;
    }
    hasMore = body.hasMore;
  }
}

export async function syncTable(table: SyncableTable): Promise<void> {
  await pushTable(table);
  await pullTable(table);
}

export async function syncAll(): Promise<void> {
  if (!navigator.onLine) return;
  for (const table of SYNCABLE_TABLES) {
    try {
      await syncTable(table);
    } catch (err) {
      // one table failing (e.g. a transient network drop mid-loop) must
      // not block the others from syncing
      console.error(`sync failed for ${table}`, err);
    }
  }
}

/**
 * The ONLY path that writes readings.photoBlobUrl after creation —
 * deliberately outside the generic push/pull loop above. See
 * docs/sync-design.md "Photo attach: a dedicated path, not a row field race".
 */
export async function attachPhoto(readingId: string, photoBlobUrl: string): Promise<void> {
  const res = await authFetch(`/api/readings/${readingId}/photo`, {
    method: "POST",
    body: JSON.stringify({ readingId, photoBlobUrl }),
  });
  if (!res.ok) throw new Error(`attachPhoto failed: ${res.status}`);
  const existing = await db.readings.get(readingId);
  if (existing) {
    await db.readings.put({ ...existing, photoBlobUrl });
  }
  await db.photoBlobs.update(readingId, { uploadStatus: "uploaded" });
}

let periodicHandle: ReturnType<typeof setInterval> | undefined;

/** Wired up once from the app shell: sync on start, on reconnect, and periodically. */
export function startSyncManager(intervalMs = 60_000): () => void {
  void syncAll();
  const onOnline = () => void syncAll();
  window.addEventListener("online", onOnline);
  periodicHandle = setInterval(() => void syncAll(), intervalMs);

  return () => {
    window.removeEventListener("online", onOnline);
    if (periodicHandle) clearInterval(periodicHandle);
  };
}
