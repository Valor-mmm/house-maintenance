import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, jwtVerify } from "jose";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

const KEY_LEN = 64;

/** scrypt over bcrypt/argon2: zero extra native dependency, no binary-compat risk on Vercel's Node runtime. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LEN);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function jwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export interface SessionPayload {
  userId: string;
  username: string;
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ username: payload.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(jwtSecret());
}

export async function verifySession(token: string): Promise<SessionPayload> {
  // Explicit algorithms allowlist as defense-in-depth: jose already
  // rejects an algorithm-family mismatch against an HMAC key by default,
  // but pinning HS256 specifically (rather than accepting any HMAC
  // variant) costs nothing and removes any doubt, flagged in a
  // pre-public-repo security review.
  const { payload } = await jwtVerify(token, jwtSecret(), { algorithms: ["HS256"] });
  if (typeof payload.sub !== "string" || typeof payload.username !== "string") {
    throw new Error("malformed session token");
  }
  return { userId: payload.sub, username: payload.username };
}
