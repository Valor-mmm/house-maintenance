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
 * reading itself was already created successfully and stays usable —
 * the photo can be retried later (no automatic retry loop exists yet;
 * see report).
 */
export async function uploadPendingPhoto(readingId: string): Promise<void> {
  const record = await db.photoBlobs.get(readingId);
  if (!record || record.uploadStatus === "uploaded") return;

  if (!hasSession()) {
    console.error(`cannot upload photo for reading ${readingId}: not authenticated`);
    await db.photoBlobs.update(readingId, { uploadStatus: "failed" });
    return;
  }

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
  }
}
