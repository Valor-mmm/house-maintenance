import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import MeterDetail from "./MeterDetail";
import { db } from "../db/dexie";
import { meter, reading } from "../test/fixtures";

function renderMeterDetail(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/meters/${id}`]}>
      <Routes>
        <Route path="/meters/:id" element={<MeterDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(async () => {
  await db.meters.clear();
  await db.readings.clear();
  await db.meterEvents.clear();
  await db.photoBlobs.clear();
  await db.outbox.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MeterDetail", () => {
  it("shows a not-found message for an id that matches no meter or group", async () => {
    renderMeterDetail("does-not-exist");
    expect(await screen.findByText("No meter or meter group found for id does-not-exist.")).toBeInTheDocument();
  });

  it("renders the meter header and an empty readings list", async () => {
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    renderMeterDetail("meter-1");

    expect(await screen.findByRole("heading", { name: "Main electricity" })).toBeInTheDocument();
    expect(screen.getByText("No readings logged yet.")).toBeInTheDocument();
  });

  it("lists an existing reading, most recent first", async () => {
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    await db.readings.add(
      reading({ id: "reading-old", meterId: "meter-1", value: 100, capturedAt: "2024-01-01T00:00:00.000Z" })
    );
    await db.readings.add(
      reading({ id: "reading-new", meterId: "meter-1", value: 150, capturedAt: "2024-06-01T00:00:00.000Z" })
    );
    renderMeterDetail("meter-1");

    const rows = await screen.findAllByText(/kWh$/);
    expect(rows[0]).toHaveTextContent("150 kWh");
    expect(rows[1]).toHaveTextContent("100 kWh");
  });

  it("logs a new reading that appears in the list and in Dexie", async () => {
    const user = userEvent.setup();
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    renderMeterDetail("meter-1");

    await screen.findByRole("heading", { name: "Main electricity" });
    await user.type(screen.getByLabelText("Value (kWh)"), "321.5");
    await user.type(screen.getByLabelText("Note (optional)"), "Monthly check");
    await user.click(screen.getByRole("button", { name: "Save reading" }));

    await waitFor(async () => expect(await db.readings.count()).toBe(1));
    const stored = await db.readings.toArray();
    expect(stored[0]).toMatchObject({ meterId: "meter-1", value: 321.5, note: "Monthly check" });
    expect(await screen.findByText(/Monthly check/)).toBeInTheDocument();

    // form resets for the next reading
    expect(screen.getByLabelText("Value (kWh)")).toHaveValue(null);
  });

  it("deletes a reading after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    await db.readings.add(reading({ id: "reading-1", meterId: "meter-1", value: 100 }));
    renderMeterDetail("meter-1");

    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(async () => expect((await db.readings.get("reading-1"))?.deletedAt).not.toBeNull());
    expect(await screen.findByText("No readings logged yet.")).toBeInTheDocument();
  });

  it("keeps the reading when deletion is not confirmed", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    await db.readings.add(reading({ id: "reading-1", meterId: "meter-1", value: 100 }));
    renderMeterDetail("meter-1");

    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect((await db.readings.get("reading-1"))?.deletedAt).toBeNull();
  });
});

describe("MeterDetail reading photos", () => {
  // jsdom implements neither of these; ReadingPhoto calls both to render
  // the still-local copy of a photo.
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => OBJECT_URL);
    URL.revokeObjectURL = vi.fn();
  });

  const OBJECT_URL = "blob:local-photo";
  const REMOTE_URL = "https://example.public.blob.vercel-storage.com/readings/reading-1/1.jpg";

  function localPhoto(uploadStatus: "pending" | "uploading" | "uploaded" | "failed") {
    return {
      readingId: "reading-1",
      blob: new Blob(["fake-jpeg-bytes"], { type: "image/jpeg" }),
      uploadStatus,
      createdAt: "2024-01-01T00:00:00.000Z",
    };
  }

  it("renders no photo affordance for a reading without one", async () => {
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    await db.readings.add(reading({ id: "reading-1", meterId: "meter-1", value: 100 }));
    renderMeterDetail("meter-1");

    await screen.findByText("100 kWh");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows an uploaded photo from its Blob URL when this device has no local copy", async () => {
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    await db.readings.add(
      reading({ id: "reading-1", meterId: "meter-1", value: 100, photoBlobUrl: REMOTE_URL })
    );
    renderMeterDetail("meter-1");

    const img = await screen.findByRole("img");
    expect(img).toHaveAttribute("src", REMOTE_URL);
    expect(screen.getByText("Photo uploaded")).toBeInTheDocument();
  });

  it("prefers the local copy over the uploaded URL, so the photo is viewable offline", async () => {
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    await db.readings.add(
      reading({ id: "reading-1", meterId: "meter-1", value: 100, photoBlobUrl: REMOTE_URL })
    );
    await db.photoBlobs.add(localPhoto("uploaded"));
    renderMeterDetail("meter-1");

    // The object URL is created in an effect, so the first paint still
    // shows the remote URL — waitFor, or this races the effect.
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", OBJECT_URL));
    // The Blob URL is still what proves it reached the server.
    expect(screen.getByText("Photo uploaded")).toBeInTheDocument();
  });

  it("shows a photo that has not been uploaded yet as not-yet-uploaded", async () => {
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    await db.readings.add(reading({ id: "reading-1", meterId: "meter-1", value: 100 }));
    await db.photoBlobs.add(localPhoto("pending"));
    renderMeterDetail("meter-1");

    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", OBJECT_URL));
    expect(screen.getByText(/Not uploaded yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry upload" })).toBeInTheDocument();
  });

  it("offers a retry for a photo stranded mid-upload by a killed session", async () => {
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    await db.readings.add(reading({ id: "reading-1", meterId: "meter-1", value: 100 }));
    await db.photoBlobs.add(localPhoto("uploading"));
    renderMeterDetail("meter-1");

    expect(await screen.findByText(/Uploading/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry upload" })).toBeInTheDocument();
  });

  it("offers a retry for a failed upload", async () => {
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    await db.readings.add(reading({ id: "reading-1", meterId: "meter-1", value: 100 }));
    await db.photoBlobs.add(localPhoto("failed"));
    renderMeterDetail("meter-1");

    expect(await screen.findByText(/upload failed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry upload" })).toBeInTheDocument();
  });

  it("opens the photo full size and closes it again", async () => {
    const user = userEvent.setup();
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    await db.readings.add(
      reading({ id: "reading-1", meterId: "meter-1", value: 100, photoBlobUrl: REMOTE_URL })
    );
    renderMeterDetail("meter-1");

    await user.click(await screen.findByRole("button", { name: /View photo/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows EXIF capture time and GPS alongside the photo", async () => {
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", unit: "kWh" }));
    await db.readings.add(
      reading({
        id: "reading-1",
        meterId: "meter-1",
        value: 100,
        photoBlobUrl: REMOTE_URL,
        photoExif: { capturedAt: "2024-01-01T09:30:00.000Z", gpsLatitude: 51.2, gpsLongitude: 6.8 },
      })
    );
    renderMeterDetail("meter-1");

    expect(await screen.findByText(/GPS 51\.20000, 6\.80000/)).toBeInTheDocument();
  });
});
