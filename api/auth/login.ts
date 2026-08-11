import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loginRequestSchema, type LoginResponse } from "@house/shared";
import { getPool, verifyPassword, signSession } from "@house/server-lib";
import { readJsonBody } from "../_lib/http.js";

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
  const { rows } = await pool.query<{ id: string; username: string; password_hash: string }>(
    "select id, username, password_hash from users where username = $1",
    [username]
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }

  const token = await signSession({ userId: user.id, username: user.username });
  const body: LoginResponse = { token, user: { id: user.id, username: user.username } };
  res.status(200).json(body);
}
