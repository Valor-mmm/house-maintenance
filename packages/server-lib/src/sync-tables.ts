import type pg from "pg";
import type { SyncableTable, SyncCursor } from "@house/shared";

interface ColumnSpec {
  /** camelCase key on the JSON row (matches packages/shared schemas) */
  key: string;
  /** snake_case column in Postgres */
  column: string;
  jsonb?: boolean;
  timestamp?: boolean;
}

export interface TableSpec {
  sqlTable: string;
  columns: ColumnSpec[];
}

/**
 * One entry per syncable table (see docs/sync-design.md). `readings`
 * deliberately excludes `photoBlobUrl` — that column is written only by
 * the dedicated /api/readings/:id/photo endpoint, never by this generic
 * push/pull path, so a photo upload can never race with an unrelated
 * field edit on the same row.
 */
export const TABLE_SPECS: Record<SyncableTable, TableSpec> = {
  meters: {
    sqlTable: "meters",
    columns: [
      { key: "propertyId", column: "property_id" },
      { key: "name", column: "name" },
      { key: "type", column: "type" },
      { key: "unit", column: "unit" },
      { key: "readingInterval", column: "reading_interval" },
      { key: "readingKind", column: "reading_kind" },
    ],
  },
  meterGroups: {
    sqlTable: "meter_groups",
    columns: [
      { key: "propertyId", column: "property_id" },
      { key: "name", column: "name" },
      { key: "unit", column: "unit" },
    ],
  },
  meterGroupMembers: {
    sqlTable: "meter_group_members",
    columns: [
      { key: "groupId", column: "group_id" },
      { key: "meterId", column: "meter_id" },
      { key: "role", column: "role" },
      { key: "signMultiplier", column: "sign_multiplier" },
    ],
  },
  meterEvents: {
    sqlTable: "meter_events",
    columns: [
      { key: "meterId", column: "meter_id" },
      { key: "eventType", column: "event_type" },
      { key: "occurredAt", column: "occurred_at", timestamp: true },
      { key: "preEventFinalValue", column: "pre_event_final_value" },
      { key: "postEventStartValue", column: "post_event_start_value" },
    ],
  },
  readings: {
    sqlTable: "readings",
    columns: [
      { key: "meterId", column: "meter_id" },
      { key: "value", column: "value" },
      { key: "capturedAt", column: "captured_at", timestamp: true },
      { key: "note", column: "note" },
      { key: "photoExif", column: "photo_exif", jsonb: true },
      { key: "clientEditedAt", column: "client_edited_at", timestamp: true },
    ],
  },
  taskTemplates: {
    sqlTable: "task_templates",
    columns: [
      { key: "propertyId", column: "property_id" },
      { key: "name", column: "name" },
      { key: "category", column: "category" },
      { key: "recurrenceRule", column: "recurrence_rule", jsonb: true },
    ],
  },
  taskInstances: {
    sqlTable: "task_instances",
    columns: [
      { key: "templateId", column: "template_id" },
      { key: "dueDate", column: "due_date", timestamp: true },
      { key: "completedAt", column: "completed_at", timestamp: true },
      { key: "completedNote", column: "completed_note" },
      { key: "cost", column: "cost" },
      { key: "lastNotifiedAt", column: "last_notified_at", timestamp: true },
    ],
  },
};

function toIso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowToJson(spec: TableSpec, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    updatedAt: toIso(row.updated_at),
    deletedAt: toIso(row.deleted_at),
  };
  for (const c of spec.columns) {
    out[c.key] = c.timestamp ? toIso(row[c.column]) : row[c.column];
  }
  return out;
}

/**
 * Insert-or-update a row. `updated_at` is always set here — this
 * function is the ONLY place a syncable row's updated_at is ever
 * assigned, never trusting a client-supplied value (see
 * docs/sync-design.md). `deleted_at` is sticky: once set, a later push
 * that doesn't also carry a deletion can never clear it — delete is
 * terminal.
 *
 * Truncated to milliseconds (`date_trunc`), not bare `now()`: Postgres
 * `timestamptz` has microsecond precision but a JS `Date` (and therefore
 * every `updatedAt` a client ever sees, stores, or echoes back as a sync
 * cursor) only has millisecond precision. Without truncating here, the
 * value actually stored is always >= the value the client can ever
 * present back, so the pull cursor's `(updated_at, id) > (cursor)`
 * comparison would never exclude the very row that produced that cursor
 * — pagination would re-deliver the last row of every page forever.
 */
export async function upsertSyncRow(
  pool: pg.Pool,
  spec: TableSpec,
  row: Record<string, unknown>
): Promise<void> {
  const entityCols = spec.columns.map((c) => c.column);
  const entityValues = spec.columns.map((c) => {
    const v = row[c.key];
    return c.jsonb && v != null ? JSON.stringify(v) : v ?? null;
  });

  const allCols = ["id", ...entityCols, "deleted_at"];
  const allValues = [row.id, ...entityValues, row.deletedAt ?? null];
  const placeholders = allValues.map((_, i) => `$${i + 1}`).join(", ");

  const setClauses = entityCols.map((col) => `${col} = EXCLUDED.${col}`);
  setClauses.push("updated_at = date_trunc('milliseconds', now())");
  setClauses.push(`deleted_at = COALESCE(${spec.sqlTable}.deleted_at, EXCLUDED.deleted_at)`);

  const text = `
    INSERT INTO ${spec.sqlTable} (${allCols.join(", ")}, updated_at)
    VALUES (${placeholders}, date_trunc('milliseconds', now()))
    ON CONFLICT (id) DO UPDATE SET ${setClauses.join(", ")}
  `;
  await pool.query(text, allValues);
}

/**
 * Restore variant of `upsertSyncRow`, used only by the backup-restore path
 * (packages/server-lib/src/backup.ts) — never by the generic sync push
 * endpoint. The difference is `deleted_at`: ordinary sync push keeps a
 * live tombstone sticky (COALESCE, "delete is terminal" per
 * docs/sync-design.md) because that rule exists to stop an unrelated
 * concurrent edit from *implicitly* resurrecting something someone just
 * deleted. Restore is the opposite situation — the user explicitly chose
 * to bring back a point-in-time snapshot, most commonly *because* they
 * deleted something by mistake — so the archive's `deleted_at` must win
 * outright, not lose to a live tombstone.
 *
 * Known gap (matches the sync-design doc's own "parking lot" note on
 * restoring deleted records): a device that already pulled the tombstone
 * into its local Dexie cache will keep treating the row as deleted per
 * its own client-side merge rule, until that device does a fresh full
 * resync. This function makes the row correct server-side and for any
 * device pulling it fresh; it does not retroactively fix an
 * already-cached client.
 */
export async function restoreSyncRow(
  pool: pg.Pool,
  spec: TableSpec,
  row: Record<string, unknown>
): Promise<void> {
  const entityCols = spec.columns.map((c) => c.column);
  const entityValues = spec.columns.map((c) => {
    const v = row[c.key];
    return c.jsonb && v != null ? JSON.stringify(v) : v ?? null;
  });

  const allCols = ["id", ...entityCols, "deleted_at"];
  const allValues = [row.id, ...entityValues, row.deletedAt ?? null];
  const placeholders = allValues.map((_, i) => `$${i + 1}`).join(", ");

  const setClauses = entityCols.map((col) => `${col} = EXCLUDED.${col}`);
  setClauses.push("updated_at = date_trunc('milliseconds', now())");
  setClauses.push("deleted_at = EXCLUDED.deleted_at");

  const text = `
    INSERT INTO ${spec.sqlTable} (${allCols.join(", ")}, updated_at)
    VALUES (${placeholders}, date_trunc('milliseconds', now()))
    ON CONFLICT (id) DO UPDATE SET ${setClauses.join(", ")}
  `;
  await pool.query(text, allValues);
}

/**
 * Every row of a syncable table, deleted or not, unpaged — used only by
 * the backup archive builder (packages/server-lib/src/backup.ts), which
 * needs the whole table in one snapshot rather than a sync page. Ordinary
 * sync pull traffic must keep using `pullSyncPage` (cursor + LIMIT); this
 * is not a substitute for that endpoint.
 */
export async function selectAllSyncRows(
  pool: pg.Pool,
  spec: TableSpec
): Promise<Record<string, unknown>[]> {
  const selectCols = ["id", ...spec.columns.map((c) => c.column), "deleted_at", "updated_at"];
  const { rows } = await pool.query(
    `SELECT ${selectCols.join(", ")} FROM ${spec.sqlTable} ORDER BY updated_at, id`
  );
  return rows.map((r) => rowToJson(spec, r));
}

export async function pullSyncPage(
  pool: pg.Pool,
  spec: TableSpec,
  cursor: SyncCursor | null,
  limit: number
): Promise<Record<string, unknown>[]> {
  const selectCols = ["id", ...spec.columns.map((c) => c.column), "deleted_at", "updated_at"];
  const text = cursor
    ? `SELECT ${selectCols.join(", ")} FROM ${spec.sqlTable}
       WHERE (updated_at, id) > ($1, $2)
       ORDER BY updated_at, id
       LIMIT $3`
    : `SELECT ${selectCols.join(", ")} FROM ${spec.sqlTable}
       ORDER BY updated_at, id
       LIMIT $1`;
  const values = cursor ? [cursor.updatedAt, cursor.id, limit] : [limit];
  const { rows } = await pool.query(text, values);
  return rows.map((r) => rowToJson(spec, r));
}
