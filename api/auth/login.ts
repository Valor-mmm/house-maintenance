import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loginRequestSchema, type LoginResponse } from "@house/shared";
import { getPool, verifyPassword, signSession } from "@house/server-lib";
import { readJsonBody } from "../_lib/http.js";

/**
 * Escalating per-username lockout (db/migrations/008_login_lockout.sql) —
 * added after a pre-public-repo security review flagged that this
 * endpoint had no brute-force resistance beyond scrypt's cost, which
 * doesn't meaningfully deter a horizontally-scaled attacker once the
 * exact auth flow is publicly readable. `failed_login_count` resets to 0
 * every time a lockout window is set OR has expired, so a lockout is
 * always a fixed MAX_FAILED_ATTEMPTS-strikes window, never a permanent
 * escalating one.
 */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  failed_login_count: number;
  locked_until: Date | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const parsed = loginRequestSchema.safeParse(readJsonBody(req));
  if (!parsed.success) {
    res.status(400).json({ error: "invalid request", issues: parsed.error.issues });
    return;
  }
  const { username, password } = parsed.data;

  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    "select id, username, password_hash, failed_login_count, locked_until from users where username = $1",
    [username]
  );
  const user = rows[0];

  const lockoutActive = Boolean(user?.locked_until && user.locked_until.getTime() > Date.now());
  if (lockoutActive) {
    res.status(429).json({ error: "too many failed attempts; try again later" });
    return;
  }

  const valid = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !valid) {
    if (user) {
      // A previously-set lockout that has since expired doesn't carry its
      // count forward — this failure starts a fresh window.
      const priorCount = user.locked_until && user.locked_until.getTime() <= Date.now() ? 0 : user.failed_login_count;
      const attempts = priorCount + 1;
      const lock = attempts >= MAX_FAILED_ATTEMPTS;
      await pool.query("update users set failed_login_count = $1, locked_until = $2 where id = $3", [
        lock ? 0 : attempts,
        lock ? new Date(Date.now() + LOCKOUT_MS) : null,
        user.id,
      ]);
    }
    res.status(401).json({ error: "invalid credentials" });
    return;
  }

  await pool.query("update users set failed_login_count = 0, locked_until = null where id = $1", [user.id]);

  const token = await signSession({ userId: user.id, username: user.username });
  const body: LoginResponse = { token, user: { id: user.id, username: user.username } };
  res.status(200).json(body);
}
