import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getPool } from "@house/server-lib";
import { requireSession } from "./_lib/http.js";

/**
 * Unacknowledged anomaly flags for the dashboard's "needs attention" list.
 * `anomaly_flags` is server-authoritative and never synced to Dexie (see
 * docs/sync-design.md), so the client fetches this directly rather than
 * reading it from local storage — see apps/web/src/data/anomalies.ts.
 */
interface AnomalyFlagRow {
  id: string;
  meter_id: string | null;
  meter_group_id: string | null;
  target_name: string | null;
  period_start: Date;
  period_end: Date;
  computed_value: number;
  baseline_value: number;
  pct_over: number;
  notified_at: Date | null;
  acknowledged_at: Date | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const session = await requireSession(req, res);
  if (!session) return;

  const pool = getPool();
  const { rows } = await pool.query<AnomalyFlagRow>(
    `SELECT af.id, af.meter_id, af.meter_group_id,
            COALESCE(m.name, mg.name) AS target_name,
            af.period_start, af.period_end,
            af.computed_value, af.baseline_value, af.pct_over,
            af.notified_at, af.acknowledged_at
     FROM anomaly_flags af
     LEFT JOIN meters m ON m.id = af.meter_id
     LEFT JOIN meter_groups mg ON mg.id = af.meter_group_id
     WHERE af.acknowledged_at IS NULL
     ORDER BY af.period_end DESC
     LIMIT 20`
  );

  const body = rows.map((r) => ({
    id: r.id,
    meterId: r.meter_id,
    meterGroupId: r.meter_group_id,
    targetName: r.target_name ?? "Unknown",
    periodStart: r.period_start.toISOString(),
    periodEnd: r.period_end.toISOString(),
    computedValue: r.computed_value,
    baselineValue: r.baseline_value,
    pctOver: r.pct_over,
    notifiedAt: r.notified_at ? r.notified_at.toISOString() : null,
    acknowledgedAt: r.acknowledged_at ? r.acknowledged_at.toISOString() : null,
  }));

  res.status(200).json(body);
}
