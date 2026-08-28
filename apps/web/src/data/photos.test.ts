import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../auth/token", () => ({ hasSession: vi.fn(() => true) }));
vi.mock("../sync/engine", () => ({ attachPhoto: vi.fn(), syncTable: vi.fn() }));
vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));

import { upload } from "@vercel/blob/client";
import { hasSession } from "../auth/token";
import { db } from "../db/dexie";
import { resumePendingPhotoUploads, uploadPendingPhoto } from "./photos";

const uploadMock = vi.mocked(upload);
const hasSessionMock = vi.mocked(hasSession);

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

/**
 * A real `Blob` does not survive a fake-indexeddb round trip with its
 * `type` intact (a browser's IndexedDB stores Blobs properly), and
 * `uploadPendingPhoto` reads `blob.type` to pick the upload's file
 * extension. `upload` is mocked here, so the bytes are never used for
 * anything — a stand-in carrying just the fields the code touches keeps
 * these tests about the retry logic rather than about the fake.
 */
function photoRecord(uploadStatus: "pending" | "uploading" | "uploaded" | "failed") {
  return {
    readingId: "reading-1",
    blob: { type: "image/jpeg", size: 16 } as unknown as Blob,
    uploadStatus,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

beforeEach(async () => {
  await db.photoBlobs.clear();
  setOnline(true);
  hasSessionMock.mockReturnValue(true);
  uploadMock.mockResolvedValue({ url: "https://blob.example/readings/reading-1/1.jpg" } as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(uploadMock).mockReset();
});

describe("resumePendingPhotoUploads", () => {
  // The bug this exists for: uploadPendingPhoto writes "uploading" before
  // it starts awaiting, and is called fire-and-forget. A page that goes
  // away mid-upload never reaches the catch, so the record is stranded in
  // "uploading" with nothing ever looking at it again.
  it("re-drives a photo stranded in 'uploading' by a previous session", async () => {
    await db.photoBlobs.add(photoRecord("uploading"));

    await resumePendingPhotoUploads();

    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("re-drives a photo that never left 'pending'", async () => {
    await db.photoBlobs.add(photoRecord("pending"));

    await resumePendingPhotoUploads();

    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("re-drives a photo whose upload previously failed", async () => {
    await db.photoBlobs.add(photoRecord("failed"));

    await resumePendingPhotoUploads();

    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("leaves an already-uploaded photo alone", async () => {
    await db.photoBlobs.add(photoRecord("uploaded"));

    await resumePendingPhotoUploads();

    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("does nothing while offline, so nothing gets marked failed for no reason", async () => {
    await db.photoBlobs.add(photoRecord("pending"));
    setOnline(false);

    await resumePendingPhotoUploads();

    expect(uploadMock).not.toHaveBeenCalled();
    expect((await db.photoBlobs.get("reading-1"))?.uploadStatus).toBe("pending");
  });

  // This runs on every app start, including on the login screen.
  it("does nothing when logged out, rather than marking every photo failed", async () => {
    await db.photoBlobs.add(photoRecord("pending"));
    hasSessionMock.mockReturnValue(false);

    await resumePendingPhotoUploads();

    expect(uploadMock).not.toHaveBeenCalled();
    expect((await db.photoBlobs.get("reading-1"))?.uploadStatus).toBe("pending");
  });
});

describe("uploadPendingPhoto", () => {
  it("does not start a second upload of the same photo while one is in flight", async () => {
    await db.photoBlobs.add(photoRecord("pending"));
    // A 25MB photo over a basement connection easily outlives the 60s
    // resume tick, so the second call must be a no-op rather than a
    // duplicate upload of the same bytes.
    let release: (v: unknown) => void = () => {};
    let markStarted: () => void = () => {};
    const uploadStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    uploadMock.mockImplementation((() => {
      markStarted();
      return new Promise((resolve) => { release = resolve; });
    }) as never);

    const first = uploadPendingPhoto("reading-1");
    await uploadStarted; // the first call is now parked inside upload()
    await uploadPendingPhoto("reading-1");

    expect(uploadMock).toHaveBeenCalledTimes(1);

    release({ url: "https://blob.example/readings/reading-1/1.jpg" });
    await first;
  });

  it("marks a photo failed when the upload rejects, so it is retryable", async () => {
    await db.photoBlobs.add(photoRecord("pending"));
    uploadMock.mockRejectedValue(new Error("network down"));

    await uploadPendingPhoto("reading-1");

    expect((await db.photoBlobs.get("reading-1"))?.uploadStatus).toBe("failed");
  });
});
