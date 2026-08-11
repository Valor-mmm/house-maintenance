import type { VercelRequest, VercelResponse } from "@vercel/node";
import { backupListResponseSchema } from "@house/shared";
import { getPool, mapBackupRow, BACKUP_ROW_COLUMNS, type BackupRow } from "@house/server-lib";
import { requireSession } from "../_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const session = await requireSession(req, res);
  if (!session) return;

  const pool = getPool();
  const { rows } = await pool.query<BackupRow>(
    `SELECT ${BACKUP_ROW_COLUMNS} FROM backups ORDER BY created_at DESC LIMIT 50`
  );
  res.status(200).json(backupListResponseSchema.parse(rows.map(mapBackupRow)));
}
