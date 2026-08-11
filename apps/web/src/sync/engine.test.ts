import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Reading } from "@house/shared";

const authFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
vi.mock("../auth/token", () => ({ authFetch: (...args: [string, RequestInit?]) => authFetch(...args) }));

// Imported after the mock so engine.ts picks up the mocked authFetch.
const { db } = await import("../db/dexie");
const { enqueueForSync, syncTable } = await import("./engine");

function reading(overrides: Partial<Reading>): Reading {
  return {
    id: "reading-1",
    meterId: "meter-1",
    value: 100,
    capturedAt: "2024-01-01T00:00:00.000Z",
    note: null,
    photoBlobUrl: null,
    photoExif: null,
    updatedAt: "2024-01-01T00:00:00.000Z",
    deletedAt: null,
    clientEditedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

beforeEach(async () => {
  authFetch.mockReset();
  await db.readings.clear();
  await db.outbox.clear();
  await db.syncCursors.clear();
});

describe("push", () => {
  it("pushes outbox entries and clears them once the server accepts", async () => {
    const row = reading({ id: "reading-1" });
    await db.readings.put(row);
    await enqueueForSync("readings", "reading-1");

    authFetch.mockResolvedValueOnce(jsonResponse({ accepted: ["reading-1"] }));
    authFetch.mockResolvedValueOnce(jsonResponse({ rows: [], nextCursor: null, hasMore: false }));

    await syncTable("readings");

    expect(authFetch).toHaveBeenCalledTimes(2); // push, then pull
    const [pushUrl, pushInit] = authFetch.mock.calls[0];
    expect(pushUrl).toBe("/api/sync?action=push");
    expect(JSON.parse(pushInit!.body as string)).toEqual({ table: "readings", rows: [row] });

    await expect(db.outbox.where("table").equals("readings").toArray()).resolves.toEqual([]);
  });

  it("leaves the outbox entry in place when the server rejects the row", async () => {
    await db.readings.put(reading({ id: "reading-1" }));
    await enqueueForSync("readings", "reading-1");

    authFetch.mockResolvedValueOnce(jsonResponse({ accepted: [] }));
    authFetch.mockResolvedValueOnce(jsonResponse({ rows: [], nextCursor: null, hasMore: false }));

    await syncTable("readings");

    const remaining = await db.outbox.where("table").equals("readings").toArray();
    expect(remaining).toHaveLength(1);
  });
});

describe("pull conflict resolution", () => {
  it("last-write-wins by server-assigned updatedAt when neither side is deleted", async () => {
    await db.readings.put(reading({ id: "reading-1", value: 100, updatedAt: "2024-01-01T00:00:00.000Z" }));

    const incoming = reading({ id: "reading-1", value: 999, updatedAt: "2024-01-02T00:00:00.000Z" });
    authFetch.mockResolvedValueOnce(
      jsonResponse({ rows: [incoming], nextCursor: null, hasMore: false })
    );

    await syncTable("readings");

    const stored = await db.readings.get("reading-1");
    expect(stored?.value).toBe(999);
  });

  it("delete is terminal: an existing tombstone is never resurrected by an incoming non-deleted row", async () => {
    await db.readings.put(
      reading({
        id: "reading-1",
        value: 100,
        updatedAt: "2024-01-05T00:00:00.000Z",
        deletedAt: "2024-01-05T00:00:00.000Z",
      })
    );

    // Incoming has a *later* updatedAt and is not deleted — under plain LWW
    // this would win, but the sticky-delete rule must still keep the tombstone.
    const incoming = reading({
      id: "reading-1",
      value: 999,
      updatedAt: "2024-01-10T00:00:00.000Z",
      deletedAt: null,
    });
    authFetch.mockResolvedValueOnce(
      jsonResponse({ rows: [incoming], nextCursor: null, hasMore: false })
    );

    await syncTable("readings");

    const stored = await db.readings.get("reading-1");
    expect(stored?.deletedAt).toBe("2024-01-05T00:00:00.000Z");
    expect(stored?.value).toBe(100);
  });

  it("merges photoBlobUrl on its own axis instead of following the row LWW winner", async () => {
    // existing "wins" the row overall (later updatedAt) but has no photo yet
    await db.readings.put(
      reading({
        id: "reading-1",
        value: 100,
        photoBlobUrl: null,
        updatedAt: "2024-01-10T00:00:00.000Z",
      })
    );

    // incoming loses the row LWW (older updatedAt) but carries the photo
    // attach's URL — it must still win on photoBlobUrl specifically.
    const incoming = reading({
      id: "reading-1",
      value: 999,
      photoBlobUrl: "https://blob.example/photo.jpg",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    authFetch.mockResolvedValueOnce(
      jsonResponse({ rows: [incoming], nextCursor: null, hasMore: false })
    );

    await syncTable("readings");

    const stored = await db.readings.get("reading-1");
    // row fields follow the LWW winner (existing)...
    expect(stored?.value).toBe(100);
    // ...but photoBlobUrl is merged independently, taking incoming's value.
    expect(stored?.photoBlobUrl).toBe("https://blob.example/photo.jpg");
  });

  it("inserts a row with no local conflict as-is", async () => {
    const incoming = reading({ id: "reading-new" });
    authFetch.mockResolvedValueOnce(
      jsonResponse({ rows: [incoming], nextCursor: null, hasMore: false })
    );

    await syncTable("readings");

    await expect(db.readings.get("reading-new")).resolves.toMatchObject({ id: "reading-new" });
  });

  it("advances the sync cursor from the server-echoed nextCursor", async () => {
    const incoming = reading({ id: "reading-1" });
    authFetch.mockResolvedValueOnce(
      jsonResponse({
        rows: [incoming],
        nextCursor: { updatedAt: "2024-01-01T00:00:00.000Z", id: "reading-1" },
        hasMore: false,
      })
    );

    await syncTable("readings");

    const cursor = await db.syncCursors.get("readings");
    expect(cursor).toMatchObject({ updatedAt: "2024-01-01T00:00:00.000Z", id: "reading-1" });
  });
});
