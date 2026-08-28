import { useEffect, useState } from "react";
import type { ExifMetadata } from "@house/shared";
import type { LocalPhotoBlob } from "../db/dexie";
import { uploadPendingPhoto } from "../data/photos";

/**
 * Viewer for the photo attached to a past reading — a thumbnail in the
 * readings list, expanding to a full-size overlay.
 *
 * Two independent sources, deliberately preferring the local one:
 *
 *  - the raw bytes still held in Dexie (`photoBlobs`) on the device that
 *    captured the photo. This is the ONLY source before the upload
 *    finishes, and the only one that works offline — which matters here,
 *    since reading a meter happens in a basement with no signal.
 *  - `readings.photoBlobUrl`, the uploaded copy in Vercel Blob. The only
 *    source on any *other* device (photo bytes are never synced, only the
 *    URL is — see docs/sync-design.md "Photo attach").
 *
 * The upload state shown next to the thumbnail is read from
 * `photoBlobUrl` first, not from the local record's `uploadStatus`: the
 * URL only ever gets written by the server-side attach endpoint, so its
 * presence is proof the bytes really landed in Blob storage. The local
 * status is a client-side guess by comparison, and is only consulted
 * while there's no URL yet.
 */
export interface ReadingPhotoProps {
  readingId: string;
  photoBlobUrl: string | null | undefined;
  photoExif: ExifMetadata | null | undefined;
  /** The local copy from `db.photoBlobs`, if this device is the one that captured it. */
  localPhoto: LocalPhotoBlob | undefined;
  /** Human-readable reading date, used for the image's alt text. */
  capturedAtLabel: string;
}

type UploadState =
  | { kind: "uploaded" }
  | { kind: "in-progress"; label: string }
  | { kind: "failed" };

function uploadStateFor(
  photoBlobUrl: string | null | undefined,
  localPhoto: LocalPhotoBlob | undefined
): UploadState {
  if (photoBlobUrl) return { kind: "uploaded" };
  if (localPhoto?.uploadStatus === "failed") return { kind: "failed" };
  return { kind: "in-progress", label: localPhoto?.uploadStatus === "uploading" ? "Uploading…" : "Not uploaded yet" };
}

/** Object URL for local bytes, revoked whenever the blob changes or the row unmounts. */
function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);

  return url;
}

function formatExifLine(exif: ExifMetadata | null | undefined): string | null {
  if (!exif) return null;
  const bits: string[] = [];
  if (exif.capturedAt) {
    bits.push(`EXIF taken ${new Date(exif.capturedAt).toLocaleString()}`);
  }
  if (exif.gpsLatitude != null && exif.gpsLongitude != null) {
    bits.push(`GPS ${exif.gpsLatitude.toFixed(5)}, ${exif.gpsLongitude.toFixed(5)}`);
  }
  return bits.length > 0 ? bits.join(" · ") : null;
}

export default function ReadingPhoto({
  readingId,
  photoBlobUrl,
  photoExif,
  localPhoto,
  capturedAtLabel,
}: ReadingPhotoProps) {
  const localUrl = useObjectUrl(localPhoto?.blob);
  const [expanded, setExpanded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const src = localUrl ?? photoBlobUrl ?? null;
  const alt = `Photo attached to the reading from ${capturedAtLabel}`;

  // Reset the error state when the source changes — e.g. a remote-only
  // photo that failed to load offline should get another chance once
  // the upload/sync fills in a usable source.
  useEffect(() => {
    setLoadFailed(false);
  }, [src]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  if (!src) return null;

  const state = uploadStateFor(photoBlobUrl, localPhoto);
  const exifLine = formatExifLine(photoExif);

  async function handleRetry() {
    setRetrying(true);
    try {
      // Never throws — it records failure back onto the local record,
      // which flows back here through the parent's live query.
      await uploadPendingPhoto(readingId);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="pb-3 flex items-start gap-3">
      {loadFailed ? (
        <div className="w-16 h-16 shrink-0 border border-border bg-bg flex items-center justify-center text-center label-plate text-muted">
          n/a
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="shrink-0 border border-border hover:border-accent transition-colors"
          aria-label={`View photo for the reading from ${capturedAtLabel}`}
        >
          <img
            src={src}
            alt={alt}
            onError={() => setLoadFailed(true)}
            className="w-16 h-16 object-cover block"
          />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="label-plate">
          {state.kind === "uploaded" && <span className="text-good">Photo uploaded</span>}
          {state.kind === "in-progress" && <span className="text-muted">Photo · {state.label}</span>}
          {state.kind === "failed" && <span className="text-danger">Photo · upload failed</span>}
        </div>
        {loadFailed && (
          <div className="text-sm text-muted mt-0.5">
            Couldn&rsquo;t load the image — it lives on the server and this device is offline.
          </div>
        )}
        {exifLine && <div className="label-plate text-muted mt-0.5">{exifLine}</div>}
        {state.kind === "failed" && (
          <button
            type="button"
            onClick={() => void handleRetry()}
            disabled={retrying}
            className="label-plate text-accent hover:text-accent-strong disabled:opacity-50 mt-1"
          >
            {retrying ? "Retrying…" : "Retry upload"}
          </button>
        )}
      </div>

      {expanded && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={() => setExpanded(false)}
          className="fixed inset-0 z-50 bg-bg text-ink flex flex-col items-center justify-center p-4 gap-3"
        >
          <img src={src} alt={alt} className="max-h-[75vh] max-w-full object-contain border border-border" />
          <div className="text-center">
            <div className="label-plate">{capturedAtLabel}</div>
            {exifLine && <div className="label-plate text-muted mt-0.5">{exifLine}</div>}
          </div>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="label-plate border border-border px-3 py-1.5 hover:border-accent transition-colors"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
