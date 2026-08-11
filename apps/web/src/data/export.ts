import type { Meter, Reading, TaskInstance, TaskTemplate } from "@house/shared";
import { db } from "../db/dexie";

/**
 * CSV export of readings/tasks — distinct from the full backup archive
 * (apps/web/src/data/backup.ts), which is a disaster-recovery snapshot of
 * every table plus photos. This is a human-readable record meant to be
 * opened in a spreadsheet (e.g. for tax records or a utility bill
 * dispute), so it's plain columns, not a faithful dump of every field.
 *
 * Dates are emitted as raw ISO 8601 strings, not `toLocaleString` —
 * deliberately locale-independent so the file sorts/parses the same way
 * regardless of which device exported it or which device later opens it.
 */

function csvField(value: string | number | null | undefined): string {
  if (value == null) return "";
  const str = String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return [headers, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n");
}

/** Pure and unit-testable — the Dexie query lives in exportReadingsCsv below. */
export function buildReadingsCsv(meters: Meter[], readings: Reading[]): string {
  const meterById = new Map(meters.map((m) => [m.id, m]));
  const rows = readings
    .filter((r) => r.deletedAt == null)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .map((r) => {
      const meter = meterById.get(r.meterId);
      return [meter?.name ?? r.meterId, meter?.type ?? "", meter?.unit ?? "", r.value, r.capturedAt, r.note ?? ""];
    });
  return toCsv(["Meter", "Type", "Unit", "Value", "Captured at", "Note"], rows);
}

/** Pure and unit-testable — the Dexie query lives in exportTasksCsv below. */
export function buildTasksCsv(templates: TaskTemplate[], instances: TaskInstance[]): string {
  const templateById = new Map(templates.map((t) => [t.id, t]));
  const rows = instances
    .filter((i) => i.deletedAt == null)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((i) => {
      const template = templateById.get(i.templateId);
      return [
        template?.name ?? i.templateId,
        template?.category ?? "",
        i.dueDate,
        i.completedAt ?? "",
        i.completedNote ?? "",
        i.cost ?? "",
      ];
    });
  return toCsv(["Task", "Category", "Due date", "Completed at", "Completed note", "Cost"], rows);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Prepending a UTF-8 BOM makes Excel (which sniffs encoding by byte order mark) render note/category text correctly instead of mojibake. */
function downloadCsv(filename: string, content: string): void {
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Deferred, not immediate: revoking right after click() can race the
  // browser's own read of the blob URL in some engines — same reasoning
  // as shareOrDownloadBackup in ../data/backup.ts.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Every meter (including soft-deleted ones) is included in the name/unit
 * lookup even though only live readings are exported — a reading's
 * history stays meaningful after its meter is later removed, so the row
 * shouldn't lose its meter's name just because the meter itself is gone.
 */
export async function exportReadingsCsv(): Promise<void> {
  const [meters, readings] = await Promise.all([db.meters.toArray(), db.readings.toArray()]);
  downloadCsv(`house-maintenance-readings-${todayStamp()}.csv`, buildReadingsCsv(meters, readings));
}

export async function exportTasksCsv(): Promise<void> {
  const [templates, instances] = await Promise.all([db.taskTemplates.toArray(), db.taskInstances.toArray()]);
  downloadCsv(`house-maintenance-tasks-${todayStamp()}.csv`, buildTasksCsv(templates, instances));
}
