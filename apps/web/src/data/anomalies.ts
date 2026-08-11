import { authFetch } from "../auth/token";

/**
 * Anomaly flags are server-authoritative and never synced to Dexie (see
 * docs/sync-design.md's server-authoritative table list) — detection only
 * runs in the daily cron (api/cron/daily-sweep.ts). This is a plain
 * fetch-on-mount, not a reactive/offline-capable Dexie liveQuery like the
 * rest of the dashboard's data, since "the server's cron already ran" is
 * inherently an online concept.
 */
export interface AnomalyFlagWithTarget {
  id: string;
  meterId: string | null;
  meterGroupId: string | null;
  /** Name of the meter or meter group this flag is about, joined server-side. */
  targetName: string;
  periodStart: string;
  periodEnd: string;
  computedValue: number;
  baselineValue: number;
  pctOver: number;
  notifiedAt: string | null;
  acknowledgedAt: string | null;
}

/** Unacknowledged anomaly flags, most recent period first. See api/anomalies.ts. */
export async function fetchUnacknowledgedAnomalies(): Promise<AnomalyFlagWithTarget[]> {
  const res = await authFetch("/api/anomalies");
  if (!res.ok) {
    throw new Error(`Failed to load anomalies (${res.status})`);
  }
  return (await res.json()) as AnomalyFlagWithTarget[];
}
