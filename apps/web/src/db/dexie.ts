import Dexie, { type Table } from "dexie";
import type {
  Meter,
  MeterGroup,
  MeterGroupMember,
  MeterEvent,
  Reading,
  TaskTemplate,
  TaskInstance,
  SyncableTable,
} from "@house/shared";

/**
 * Local photo bytes, held here until uploaded directly to Vercel Blob.
 * `readings.photoBlobUrl` is filled in afterwards via the dedicated
 * attach path (see docs/sync-design.md), never via generic row sync.
 */
export interface LocalPhotoBlob {
  readingId: string;
  blob: Blob;
  uploadStatus: "pending" | "uploading" | "uploaded" | "failed";
  createdAt: string;
}

/** Compound (updatedAt, id) pull watermark per table — server-echoed, never computed locally. */
export interface SyncCursorRecord {
  table: SyncableTable;
  updatedAt: string;
  id: string;
}

/**
 * Rows waiting to be pushed to the server. Any local create/edit on a
 * syncable table must add an entry here (see `enqueueForSync` in
 * ../sync/engine.ts) — the push loop has no other way to find dirty rows.
 */
export interface OutboxEntry {
  id?: number;
  table: SyncableTable;
  rowId: string;
  queuedAt: string;
}

class HouseDb extends Dexie {
  meters!: Table<Meter, string>;
  meterGroups!: Table<MeterGroup, string>;
  meterGroupMembers!: Table<MeterGroupMember, string>;
  meterEvents!: Table<MeterEvent, string>;
  readings!: Table<Reading, string>;
  taskTemplates!: Table<TaskTemplate, string>;
  taskInstances!: Table<TaskInstance, string>;
  photoBlobs!: Table<LocalPhotoBlob, string>;
  syncCursors!: Table<SyncCursorRecord, string>;
  outbox!: Table<OutboxEntry, number>;

  constructor() {
    super("house-maintenance");
    this.version(1).stores({
      meters: "id, propertyId, updatedAt, deletedAt",
      meterGroups: "id, propertyId, updatedAt, deletedAt",
      meterGroupMembers: "id, groupId, meterId, updatedAt, deletedAt",
      meterEvents: "id, meterId, updatedAt, deletedAt",
      readings: "id, meterId, capturedAt, updatedAt, deletedAt",
      taskTemplates: "id, propertyId, updatedAt, deletedAt",
      taskInstances: "id, templateId, dueDate, updatedAt, deletedAt",
      photoBlobs: "readingId, uploadStatus",
      syncCursors: "table",
      outbox: "++id, table, rowId",
    });
  }
}

export const db = new HouseDb();

/** Type-safe accessor for a Dexie table by its SyncableTable name. */
export function tableFor(name: SyncableTable): Table<Record<string, unknown>, string> {
  return (db as unknown as Record<SyncableTable, Table<Record<string, unknown>, string>>)[name];
}
