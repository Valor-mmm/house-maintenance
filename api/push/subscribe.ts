import type { VercelRequest, VercelResponse } from "@vercel/node";
import { pushSubscriptionCreateInputSchema } from "@house/shared";
import { getPool } from "@house/server-lib";
import { requireSession, readJsonBody } from "../_lib/http.js";

/**
 * Registers (or re-registers) a Web Push subscription for the signed-in
 * user. `push_subscriptions` is server-authoritative — not offline-synced
 * (see docs/sync-design.md) — so this is a direct upsert, no sync
 * metadata involved.
 *
 * `userId` comes from the session, never the client, so a request can't
 * register a subscription against an arbitrary user.
 */
const bodySchema = pushSubscriptionCreateInputSchema.omit({ userId: true });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const session = await requireSession(req, res);
  if (!session) return;

  const parsed = bodySchema.safeParse(readJsonBody(req));
  if (!parsed.success) {
    res.status(400).json({ error: "invalid request", issues: parsed.error.issues });
    return;
  }
  const { endpoint, keys } = parsed.data;

  const pool = getPool();
  await pool.query(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, keys_json)
     VALUES (gen_random_uuid(), $1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id, keys_json = EXCLUDED.keys_json`,
    [session.userId, endpoint, JSON.stringify(keys)]
  );

  res.status(200).json({ ok: true });
}
