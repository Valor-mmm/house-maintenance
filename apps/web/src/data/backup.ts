import { upload } from "@vercel/blob/client";
import type { BackupRecord, BackupListResponse, BackupRestoreResponse } from "@house/shared";
import { authFetch, getToken } from "../auth/token";

export async function runBackup(): Promise<BackupRecord> {
  const res = await authFetch("/api/backup/run", { method: "POST" });
  if (!res.ok) throw new Error(`Backup failed (${res.status}).`);
  return res.json();
}

export async function listBackups(): Promise<BackupListResponse> {
  const res = await authFetch("/api/backup/list");
  if (!res.ok) throw new Error(`Failed to load backups (${res.status}).`);
  return res.json();
}

/** Downloads a backup's archive bytes through the authenticated proxy — never the raw Blob URL (see api/backup/[id]/download.ts). */
async function fetchBackupFile(backup: BackupRecord): Promise<File> {
  const res = await authFetch(`/api/backup/${backup.id}/download`);
  if (!res.ok) throw new Error(`Failed to download backup (${res.status}).`);
  const blob = await res.blob();
  const filename = `house-maintenance-backup-${backup.createdAt.slice(0, 10)}.zip`;
  return new File([blob], filename, { type: "application/zip" });
}

export type ShareOutcome = "shared" | "cancelled" | "downloaded";

/**
 * Hands the archive to the OS share sheet (Web Share API) so the user can
 * pick "Proton Drive" — or anywhere else the OS offers — in one tap.
 * Falls back to a plain browser download when Web Share with files isn't
 * supported (most desktop browsers). This can never be silent/automatic
 * on a phone: sharing files requires an actual user gesture (this
 * function must be called directly from a click handler, not a timer),
 * which is a browser security rule, not something this app or Proton
 * controls — see the brainstorm that led to this design.
 */
export async function shareOrDownloadBackup(backup: BackupRecord): Promise<ShareOutcome> {
  const file = await fetchBackupFile(backup);

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "House Maintenance backup",
        text: `Backup from ${backup.createdAt.slice(0, 10)}`,
      });
      return "shared";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
      throw err;
    }
  }

  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  // Deferred, not immediate: revoking right after click() can race the
  // browser's own read of the blob URL in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "downloaded";
}

/**
 * Uploads a restore archive (e.g. one pulled back down from Proton Drive)
 * straight to Vercel Blob via api/backup/upload.ts's signed-token flow —
 * same browser-direct-upload pattern as apps/web/src/data/photos.ts, and
 * for the same reason: sidesteps Vercel Functions' 4.5MB body limit.
 */
export async function uploadRestoreArchive(file: File): Promise<string> {
  const token = getToken();
  if (!token) throw new Error("Not authenticated.");
  const result = await upload(`restore-uploads/${Date.now()}-${file.name}`, file, {
    access: "public",
    handleUploadUrl: "/api/backup/upload",
    clientPayload: JSON.stringify({ authToken: token }),
  });
  return result.url;
}

export async function restoreFromBlobUrl(blobUrl: string): Promise<BackupRestoreResponse> {
  const res = await authFetch("/api/backup/restore", { method: "POST", body: JSON.stringify({ blobUrl }) });
  if (!res.ok) throw new Error(`Restore failed (${res.status}).`);
  return res.json();
}

export async function restoreFromBackupId(backupId: string): Promise<BackupRestoreResponse> {
  const res = await authFetch("/api/backup/restore", { method: "POST", body: JSON.stringify({ backupId }) });
  if (!res.ok) throw new Error(`Restore failed (${res.status}).`);
  return res.json();
}
