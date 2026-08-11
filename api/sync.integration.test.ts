import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPool, signSession } from "@house/server-lib";
import handler from "./sync.js";
import { mockReq, mockRes } from "./_lib/test-http.js";

const SEED_PROPERTY_ID = "00000000-0000-0000-0000-000000000001";
const meterId = randomUUID();
let token: string;

beforeAll(async () => {
  process.env.JWT_SECRET ??= "integration-test-only-secret";
  token = await signSession({ userId: randomUUID(), username: "sync-integration-tester" });

  await getPool().query(
    `insert into meters (id, property_id, name, type, unit, reading_interval, reading_kind)
     values ($1, $2, 'Integration test meter', 'water', 'm3', 'monthly', 'cumulative')`,
    [meterId, SEED_PROPERTY_ID]
  );
});

afterAll(async () => {
  await getPool().query("delete from readings where meter_id = $1", [meterId]);
  await getPool().query("delete from meters where id = $1", [meterId]);
  await getPool().end();
});

function authedReq(query: Record<string, string>, body: unknown) {
  return mockReq({ query, cookies: { session: token }, body });
}

function readingRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    meterId,
    value: 42,
    capturedAt: "2024-01-01T00:00:00.000Z",
    note: null,
    photoExif: null,
    clientEditedAt: "2024-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("api/sync push+pull round trip", () => {
  it("rejects a request without a session cookie", async () => {
    const req = mockReq({ query: { action: "push" }, body: { table: "readings", rows: [] } });
    const { res, result } = mockRes();

    await handler(req, res);

    expect(result().status).toBe(401);
  });

  it("accepts a pushed row and assigns updatedAt server-side, never trusting a client value", async () => {
    const row = readingRow();
    const req = authedReq({ action: "push" }, { table: "readings", rows: [row] });
    const { res, result } = mockRes();

    await handler(req, res);

    const { status, body } = result();
    expect(status).toBe(200);
    expect(body).toMatchObject({ table: "readings", accepted: [row.id] });

    const { rows: dbRows } = await getPool().query("select updated_at from readings where id = $1", [
      row.id,
    ]);
    expect(dbRows).toHaveLength(1);
    expect(dbRows[0].updated_at).toBeInstanceOf(Date);
  });

  it("pulls a pushed row back with the server-assigned updatedAt and a matching cursor", async () => {
    const row = readingRow();
    await handler(authedReq({ action: "push" }, { table: "readings", rows: [row] }), mockRes().res);

    const pullReq = authedReq({ action: "pull" }, { table: "readings", cursor: null });
    const { res, result } = mockRes();
    await handler(pullReq, res);

    const { status, body } = result() as {
      status: number;
      body: { rows: Array<{ id: string; value: number }>; nextCursor: { id: string } | null; hasMore: boolean };
    };
    expect(status).toBe(200);
    const pulled = body.rows.find((r) => r.id === row.id);
    expect(pulled).toMatchObject({ id: row.id, value: 42 });
    expect(body.nextCursor).not.toBeNull();
    expect(body.hasMore).toBe(false);
  });

  it("an incremental pull using the previous nextCursor only returns rows pushed after it", async () => {
    const rowA = readingRow({ value: 1 });
    await handler(authedReq({ action: "push" }, { table: "readings", rows: [rowA] }), mockRes().res);

    const firstPullRes = mockRes();
    await handler(authedReq({ action: "pull" }, { table: "readings", cursor: null }), firstPullRes.res);
    const firstBody = firstPullRes.result().body as { nextCursor: { updatedAt: string; id: string } };
    const cursorAfterA = firstBody.nextCursor;
    expect(cursorAfterA).toBeTruthy();

    const rowB = readingRow({ value: 2 });
    await handler(authedReq({ action: "push" }, { table: "readings", rows: [rowB] }), mockRes().res);

    const secondPullRes = mockRes();
    await handler(
      authedReq({ action: "pull" }, { table: "readings", cursor: cursorAfterA }),
      secondPullRes.res
    );
    const secondBody = secondPullRes.result().body as { rows: Array<{ id: string }> };

    expect(secondBody.rows.map((r) => r.id)).toEqual([rowB.id]);
    expect(secondBody.rows.map((r) => r.id)).not.toContain(rowA.id);
  });
});
