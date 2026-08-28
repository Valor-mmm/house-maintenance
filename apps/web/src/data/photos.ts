import { parse as exifrParse } from "exifr";
import { upload } from "@vercel/blob/client";
import type { ExifMetadata } from "@house/shared";
import { db } from "../db/dexie";
import { attachPhoto, syncTable } from "../sync/engine";
import { hasSession } from "../auth/token";

/**
 * Best-effort EXIF extraction for a captured/selected photo, matching
 * `ExifMetadata` in packages/shared/src/reading.ts (capturedAt + GPS).
 * Never throws — a photo with no/unreadable EXIF (e.g. a screenshot, or
 * a browser that stripped it) just yields `null`, and the caller falls
 * back to the user-entered capturedAt.
 */
export async function extractExif(file: Blob): Promise<ExifMetadata | null> {
  try {
    const tags = await exifrParse(file, { gps: true });
    if (!tags) return null;

    const dateValue: unknown = tags.DateTimeOriginal ?? tags.CreateDate ?? tags.DateTimeDigitized;
    const capturedAt =
      dateValue instanceof Date && !Number.isNaN(dateValue.getTime())
        ? dateValue.toISOString()
        : null;
    const gpsLatitude = typeof tags.latitude === "number" ? tags.latitude : null;
    const gpsLongitude = typeof tags.longitude === "number" ? tags.longitude : null;

    if (capturedAt == null && gpsLatitude == null && gpsLongitude == null) return null;
    return { capturedAt, gpsLatitude, gpsLongitude };
  } catch (err) {
    console.warn("EXIF extraction failed; continuing without it", err);
    return null;
  }
}

/** Stores the raw photo bytes locally, pending upload. Call before/alongside `createReading`. */
export async function storeLocalPhoto(readingId: string, blob: Blob): Promise<void> {
  await db.photoBlobs.put({
    readingId,
    blob,
    uploadStatus: "pending",
    createdAt: new Date().toISOString(),
  });
}

function extensionFor(blob: Blob): string {
  const subtype = blob.type.split("/")[1];
  return subtype ? subtype.replace("jpeg", "jpg") : "jpg";
}

/**
 * Uploads a reading's pending local photo directly to Vercel Blob (see
 * docs/sync-design.md "Photo attach") and, on success, attaches the
 * resulting URL via the dedicated `attachPhoto` path — never via generic
 * sync. Never throws: a failure (offline, missing server-side
 * BLOB_READ_WRITE_TOKEN in this dev environment, etc.) is logged and
 * recorded as `uploadStatus: "failed"` on the local blob record, but the
 * reading itself was already created successfully and stays usable.
 * `startPhotoUploadManager` below re-drives anything left unfinished.
 *
 * The in-flight guard is what makes that re-drive safe: the manager ticks
 * every 60s, and a photo can easily take longer than that to upload over
 * the kind of connection a basement offers. Without the guard each tick
 * would start a second, third, ... upload of the same bytes.
 */
export async function uploadPendingPhoto(readingId: string): Promise<void> {
  const record = await db.photoBlobs.get(readingId);
  if (!record || record.uploadStatus === "uploaded") return;
  if (inFlight.has(readingId)) return;

  if (!hasSession()) {
    console.error(`cannot upload photo for reading ${readingId}: not authenticated`);
    await db.photoBlobs.update(readingId, { uploadStatus: "failed" });
    return;
  }

  inFlight.add(readingId);
  try {
    await db.photoBlobs.update(readingId, { uploadStatus: "uploading" });
    // The reading itself only reaches the server via the periodic
    // background sync loop (up to 60s later — see startSyncManager),
    // but attachPhoto's UPDATE below only matches a row that already
    // exists server-side. Callers upload the photo right after creating
    // the reading, so without this the attach almost always loses that
    // race and 404s even though everything succeeded. Push readings now
    // so the row is there by the time attachPhoto runs.
    await syncTable("readings");
    const pathname = `readings/${readingId}/${Date.now()}.${extensionFor(record.blob)}`;
    const result = await upload(pathname, record.blob, {
      access: "public",
      handleUploadUrl: "/api/blob/upload",
      // Session auth rides along as a same-origin cookie automatically —
      // see api/blob/upload.ts's onBeforeGenerateToken. clientPayload just
      // carries the reading id.
      clientPayload: JSON.stringify({ readingId }),
    });
    await attachPhoto(readingId, result.url); // also sets uploadStatus: "uploaded"
  } catch (err) {
    console.error(`photo upload failed for reading ${readingId}`, err);
    await db.photoBlobs.update(readingId, { uploadStatus: "failed" });
  } finally {
    inFlight.delete(readingId);
  }
}

/**
 * Photos in flight in THIS page session. Deliberately in memory and not in
 * Dexie: the whole point is to distinguish "an upload is genuinely running
 * right now" from "a previous session wrote `uploading` and then died",
 * and a persisted flag couldn't tell those apart — which is exactly the
 * bug this module had.
 */
const inFlight = new Set<string>();

/**
 * Re-drives every photo that hasn't reached Blob storage yet.
 *
 * `uploadPendingPhoto` writes `uploadStatus: "uploading"` before it starts
 * awaiting, and it's called fire-and-forget from the log-reading form. So
 * if the page goes away mid-upload — tab closed, phone asleep, browser
 * reclaiming memory, a connection that stalls without ever erroring — the
 * catch block never runs and the record is stranded in `"uploading"`
 * forever. Nothing used to look at it again: the sync engine's outbox
 * covers syncable rows, but photo bytes live outside sync entirely (see
 * docs/sync-design.md "Photo attach"), so they had no equivalent.
 *
 * This is that equivalent. Both `"uploading"` and `"pending"` are treated
 * as unfinished, since neither is proof of anything; only a
 * `readings.photoBlobUrl` written by the server-side attach endpoint is,
 * and reaching that is what flips a record to `"uploaded"`.
 *
 * Uploads run one at a time rather than in parallel — these are up to
 * 25MB each over a connection that is often the reason they failed in the
 * first place.
 */
export async function resumePendingPhotoUploads(): Promise<void> {
  // hasSession() matters here in a way it doesn't for a fresh capture:
  // this runs on every app start, including on the login screen, and
  // uploadPendingPhoto marks a photo `failed` when unauthenticated.
  // Without this check every stranded photo would be marked failed the
  // moment the app opens logged out.
  if (!navigator.onLine || !hasSession()) return;

  const unfinished = await db.photoBlobs.where("uploadStatus").notEqual("uploaded").toArray();
  for (const record of unfinished) {
    await uploadPendingPhoto(record.readingId);
  }
}

let periodicHandle: ReturnType<typeof setInterval> | undefined;

/**
 * Wired up once from the app shell, mirroring `startSyncManager`: resume
 * on start, on reconnect, and periodically. Kept as its own manager
 * rather than folded into the sync engine because photo bytes are not a
 * syncable table — and because sync/engine.ts importing this module would
 * close an import cycle (this module already imports from it).
 */
export function startPhotoUploadManager(intervalMs = 60_000): () => void {
  void resumePendingPhotoUploads();
  const onOnline = () => void resumePendingPhotoUploads();
  window.addEventListener("online", onOnline);
  periodicHandle = setInterval(() => void resumePendingPhotoUploads(), intervalMs);

  return () => {
    window.removeEventListener("online", onOnline);
    if (periodicHandle) clearInterval(periodicHandle);
  };
}
