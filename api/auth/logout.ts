import type { VercelRequest, VercelResponse } from "@vercel/node";
import { clearSessionCookies } from "../_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  clearSessionCookies(res);
  res.status(204).end();
}
