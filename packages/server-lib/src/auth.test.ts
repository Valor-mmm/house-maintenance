import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT } from "jose";
import { hashPassword, verifyPassword, signSession, verifySession } from "./auth.js";

beforeAll(() => {
  process.env.JWT_SECRET = "test-only-secret-do-not-use-in-prod";
});

describe("hashPassword / verifyPassword", () => {
  it("round-trips: a password verifies against its own hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("produces a different hash (different salt) for the same password each time", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
  });

  it("rejects a malformed stored hash instead of throwing", async () => {
    await expect(verifyPassword("anything", "not-a-valid-stored-hash")).resolves.toBe(false);
  });
});

describe("signSession / verifySession", () => {
  it("round-trips: a signed session verifies back to the same payload", async () => {
    const token = await signSession({ userId: "user-1", username: "alice" });
    await expect(verifySession(token)).resolves.toEqual({ userId: "user-1", username: "alice" });
  });

  it("rejects a tampered token", async () => {
    const token = await signSession({ userId: "user-1", username: "alice" });
    const tampered = token.slice(0, -4) + (token.slice(-4) === "aaaa" ? "bbbb" : "aaaa");
    await expect(verifySession(tampered)).rejects.toThrow();
  });

  it("rejects a token signed with a different secret", async () => {
    const wrongKey = new TextEncoder().encode("a-completely-different-secret");
    const token = await new SignJWT({ username: "alice" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(wrongKey);
    await expect(verifySession(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const key = new TextEncoder().encode(process.env.JWT_SECRET);
    const expired = await new SignJWT({ username: "alice" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 40)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60) // expired 1 minute ago
      .sign(key);
    await expect(verifySession(expired)).rejects.toThrow();
  });

  it("rejects a token missing the username claim as malformed", async () => {
    const key = new TextEncoder().encode(process.env.JWT_SECRET);
    const noUsername = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key);
    await expect(verifySession(noUsername)).rejects.toThrow("malformed session token");
  });

  it("rejects a token signed with an unexpected algorithm", async () => {
    const key = new TextEncoder().encode(process.env.JWT_SECRET);
    const hs384Token = await new SignJWT({ username: "alice" })
      .setProtectedHeader({ alg: "HS384" })
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key);
    await expect(verifySession(hs384Token)).rejects.toThrow();
  });
});
