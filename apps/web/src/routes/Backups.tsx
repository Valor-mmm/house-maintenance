import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupRecord, BackupRestoreResponse } from "@house/shared";
import {
  runBackup,
  listBackups,
  shareOrDownloadBackup,
  uploadRestoreArchive,
  restoreFromBlobUrl,
  restoreFromBackupId,
} from "../data/backup";
import { exportReadingsCsv, exportTasksCsv } from "../data/export";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Plain-CSV export, distinct from the full backup archive above: a
 * human-readable record (readings or completed/pending tasks) meant to
 * be opened in a spreadsheet — e.g. for tax records or a utility bill
 * dispute — not a disaster-recovery snapshot. See ../data/export.ts.
 */
function ExportSection() {
  const [busy, setBusy] = useState<"readings" | "tasks" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExport(kind: "readings" | "tasks") {
    setBusy(kind);
    setError(null);
    try {
      await (kind === "readings" ? exportReadingsCsv() : exportTasksCsv());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border border-border bg-surface px-4 py-3 flex items-center gap-4 mb-6">
      <div className="flex-1 min-w-0">
        <div className="label-plate">Export data</div>
        <p className="text-sm mt-0.5">
          Download readings or tasks as a plain CSV file for a spreadsheet — e.g. tax records or a utility bill
          dispute. For full disaster recovery, use the backup above instead.
        </p>
        {error && <p className="text-sm mt-1 text-danger">{error}</p>}
      </div>
      <div className="flex flex-col gap-2 shrink-0">
        <button
          type="button"
          onClick={() => void handleExport("readings")}
          disabled={busy !== null}
          className="border border-border font-mono text-xs tracking-wide px-3 py-2 hover:border-accent transition-colors disabled:opacity-50"
        >
          {busy === "readings" ? "Exporting…" : "Export readings (CSV)"}
        </button>
        <button
          type="button"
          onClick={() => void handleExport("tasks")}
          disabled={busy !== null}
          className="border border-border font-mono text-xs tracking-wide px-3 py-2 hover:border-accent transition-colors disabled:opacity-50"
        >
          {busy === "tasks" ? "Exporting…" : "Export tasks (CSV)"}
        </button>
      </div>
    </div>
  );
}

export default function Backups() {
  const [backups, setBackups] = useState<BackupRecord[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<{ id: string; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBackups(await listBackups());
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load backups.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleRunBackup() {
    setRunning(true);
    setRunError(null);
    try {
      await runBackup();
      await refresh();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Backup failed.");
    } finally {
      setRunning(false);
    }
  }

  async function handleShare(backup: BackupRecord) {
    setRowBusyId(backup.id);
    setRowMessage(null);
    try {
      const outcome = await shareOrDownloadBackup(backup);
      setRowMessage({
        id: backup.id,
        text: outcome === "shared" ? "Shared." : outcome === "downloaded" ? "Downloaded." : "Cancelled.",
      });
    } catch (err) {
      setRowMessage({ id: backup.id, text: err instanceof Error ? err.message : "Failed to save a copy." });
    } finally {
      setRowBusyId(null);
    }
  }

  async function handleRestore(backup: BackupRecord) {
    if (
      !window.confirm(
        `Restore from the ${formatDateTime(backup.createdAt)} backup? This merges that snapshot's data back in — nothing currently in the database is deleted, but this can't be undone.`
      )
    ) {
      return;
    }
    setRowBusyId(backup.id);
    setRowMessage(null);
    try {
      const result = await restoreFromBackupId(backup.id);
      setRowMessage({ id: backup.id, text: summarizeRestore(result) });
    } catch (err) {
      setRowMessage({ id: backup.id, text: err instanceof Error ? err.message : "Restore failed." });
    } finally {
      setRowBusyId(null);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 pt-8 pb-4 md:pt-12">
      <header className="mb-6">
        <div className="label-plate">House Maintenance</div>
        <h1 className="font-display italic text-3xl md:text-4xl mt-1">Backups</h1>
      </header>

      <div className="tick-rule mb-6" />

      <div className="border border-border bg-surface px-4 py-3 flex items-center gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <div className="label-plate">Manual backup</div>
          <p className="text-sm mt-0.5">
            Snapshots every meter, reading, task and photo into one archive stored in Blob. A weekly automated
            backup also runs on its own — see the list below.
          </p>
          {runError && <p className="text-sm mt-1 text-danger">{runError}</p>}
        </div>
        <button
          type="button"
          onClick={() => void handleRunBackup()}
          disabled={running}
          className="border border-accent-strong bg-accent text-surface font-mono text-xs tracking-wide px-3 py-2 hover:bg-accent-strong transition-colors shrink-0 disabled:opacity-50"
        >
          {running ? "Backing up…" : "Back up now"}
        </button>
      </div>

      <ExportSection />

      <div className="border border-border bg-surface mb-6">
        <div className="p-4 border-b border-border label-plate">History</div>
        {listError && <p className="px-4 py-3 text-sm text-danger">{listError}</p>}
        {!listError && backups == null && <p className="px-4 py-3 text-sm text-muted">Loading…</p>}
        {!listError && backups?.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted">No backups yet — run one above.</p>
        )}
        {backups && backups.length > 0 && (
          <div className="divide-y divide-border">
            {backups.map((b) => (
              <div key={b.id} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{
                      backgroundColor:
                        b.status === "complete"
                          ? "var(--color-good)"
                          : b.status === "failed"
                            ? "var(--color-danger)"
                            : "var(--color-warn)",
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="truncate">
                      {b.kind === "manual" ? "Manual" : "Automated"} · {formatDateTime(b.createdAt)}
                    </div>
                    <div className="label-plate mt-0.5">
                      {b.status}
                      {b.status === "complete" && ` · ${formatBytes(b.sizeBytes)} · ${b.photoCount ?? 0} photos`}
                      {b.status === "failed" && b.error ? ` · ${b.error}` : ""}
                    </div>
                  </div>
                </div>
                {b.status === "complete" && (
                  <div className="pl-5 pt-2 flex flex-wrap items-center gap-3">
                    <button
                      className="label-plate text-accent hover:text-accent-strong disabled:opacity-50"
                      onClick={() => void handleShare(b)}
                      disabled={rowBusyId === b.id}
                    >
                      {rowBusyId === b.id ? "Working…" : "Save a copy"}
                    </button>
                    <button
                      className="label-plate text-danger hover:opacity-80 disabled:opacity-50"
                      onClick={() => void handleRestore(b)}
                      disabled={rowBusyId === b.id}
                    >
                      Restore this backup
                    </button>
                    {rowMessage?.id === b.id && <span className="text-sm text-muted">{rowMessage.text}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <RestoreFromFile onRestored={refresh} />
    </div>
  );
}

function summarizeRestore(result: BackupRestoreResponse): string {
  const total = Object.values(result.tableCounts).reduce((a, b) => a + b, 0);
  const parts = [`Restored ${total} rows`, `${result.photosRestored} photos`];
  if (result.usersCreatedWithDisabledPassword.length > 0) {
    parts.push(
      `⚠ new login(s) need a password: run db:seed-user for ${result.usersCreatedWithDisabledPassword.join(", ")}`
    );
  }
  return `${parts.join(", ")}.`;
}

/**
 * Upload-and-restore from an archive this deployment doesn't already know
 * about — the path that makes disaster recovery from an offsite copy
 * (Proton Drive) actually work once this deployment's own backup history
 * is gone too. See api/backup/upload.ts / api/backup/restore.ts.
 */
function RestoreFromFile({ onRestored }: { onRestored: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFileChosen(file: File) {
    if (
      !window.confirm(
        "Restore from this file? This merges its data back into the database — nothing currently there is deleted, but this can't be undone."
      )
    ) {
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const blobUrl = await uploadRestoreArchive(file);
      const result = await restoreFromBlobUrl(blobUrl);
      setMessage(summarizeRestore(result));
      onRestored();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="border border-border bg-surface px-4 py-3">
      <div className="label-plate">Restore from a file</div>
      <p className="text-sm mt-0.5">
        Pick a backup archive saved outside this app (e.g. from Proton Drive) to merge its data back in. Requires
        being logged in already — if the whole database was lost, run <code>db:seed-user</code> first to get one
        login, then come back here.
      </p>
      {error && <p className="text-sm mt-1 text-danger">{error}</p>}
      {message && <p className="text-sm mt-1 text-muted">{message}</p>}
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFileChosen(file);
        }}
        className="mt-2 text-sm disabled:opacity-50"
      />
    </div>
  );
}
