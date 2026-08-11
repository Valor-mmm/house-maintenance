import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { getPool, hashPassword } from "@house/server-lib";
import handler from "./login.js";
import { mockReq, mockRes } from "../_lib/test-http.js";

const USERNAME = "integration-test-login-user";

async function createUser(password: string): Promise<void> {
  const hash = await hashPassword(password);
  await getPool().query("insert into users (username, password_hash) values ($1, $2)", [USERNAME, hash]);
}

beforeAll(() => {
  process.env.JWT_SECRET ??= "integration-test-only-secret";
});

afterEach(async () => {
  await getPool().query("delete from users where username = $1", [USERNAME]);
});

afterAll(async () => {
  await getPool().end();
});

describe("POST /api/auth/login", () => {
  it("returns the user and sets a session cookie for correct credentials", async () => {
    await createUser("correct-password");
    const req = mockReq({ body: { username: USERNAME, password: "correct-password" } });
    const { res, result } = mockRes();

    await handler(req, res);

    const { status, body, headers } = result();
    expect(status).toBe(200);
    expect(body).toMatchObject({ user: { username: USERNAME } });
    expect(body).not.toHaveProperty("token");

    const setCookie = headers["Set-Cookie"];
    expect(Array.isArray(setCookie)).toBe(true);
    const cookies = setCookie as string[];
    expect(cookies.some((c) => c.startsWith("session=") && c.includes("HttpOnly"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("session_present=1") && !c.includes("HttpOnly"))).toBe(true);
  });

  it("rejects an unknown username with 401", async () => {
    const req = mockReq({ body: { username: "no-such-user", password: "whatever" } });
    const { res, result } = mockRes();

    await handler(req, res);

    expect(result().status).toBe(401);
  });

  it("rejects a wrong password with 401", async () => {
    await createUser("correct-password");
    const req = mockReq({ body: { username: USERNAME, password: "wrong-password" } });
    const { res, result } = mockRes();

    await handler(req, res);

    expect(result().status).toBe(401);
  });

  it("locks the account out after 5 failed attempts, even with the right password", async () => {
    await createUser("correct-password");

    for (let i = 0; i < 5; i++) {
      const req = mockReq({ body: { username: USERNAME, password: "wrong-password" } });
      const { res, result } = mockRes();
      await handler(req, res);
      expect(result().status).toBe(401);
    }

    const req = mockReq({ body: { username: USERNAME, password: "correct-password" } });
    const { res, result } = mockRes();
    await handler(req, res);

    expect(result().status).toBe(429);
  });

  it("rejects a non-POST method", async () => {
    const req = mockReq({ method: "GET", body: {} });
    const { res, result } = mockRes();

    await handler(req, res);

    expect(result().status).toBe(405);
  });
});
