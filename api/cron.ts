import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put, del } from "@vercel/blob";
import {
  computeMonthlySeries,
  computeGroupSeries,
  checkAnomaly,
  type ReadingPoint,
  type MeterEventPoint,
  type PeriodConsumption,
  type ReadingInterval,
  type MeterType,
} from "@house/shared";
import {
  getPool,
  loadPushSubscriptions,
  sendPushToAll,
  buildBackupArchive,
  BACKUP_ROW_COLUMNS,
  type PushSubRow,
  type BackupRow,
} from "@house/server-lib";

/**
 * Consolidated cron endpoint — the daily notification sweep and the
 * weekly automated backup in one file, instead of two separate files as
 * originally built. Same reason as api/backup.ts and api/sync.ts:
 * Vercel's Hobby plan caps a deployment at 12 Serverless Functions.
 *
 * vercel.json has two `crons` entries, both pointing at `/api/cron`, each
 * with its own schedule. Vercel doesn't pass which schedule triggered a
 * given invocation as a query param — instead it sends an
 * `x-vercel-cron-schedule` header carrying the exact cron expression, so
 * that's what `resolveJob` matches against (must stay byte-identical to
 * vercel.json's `schedule` strings). `?job=sweep` / `?job=backup` is also
 * accepted, for manually testing either job via curl the way
 * docs/deployment.md's verification steps do — there's no
 * x-vercel-cron-schedule header on a manual request.
 *
 * Security: Vercel signs its own cron invocations with
 * `Authorization: Bearer $CRON_SECRET`. This is otherwise a public HTTPS
 * endpoint, so we fail closed (401) whenever CRON_SECRET is unset or the
 * header doesn't match — an unauthenticated caller must never be able to
 * trigger pushes, advance notification-dedup state, or spend a backup run.
 */
const DAILY_SWEEP_SCHEDULE = "0 6 * * *";
const BACKUP_SCHEDULE = "0 7 * * 0";

function resolveJob(req: VercelRequest): "sweep" | "backup" | null {
  if (req.query.job === "sweep") return "sweep";
  if (req.query.job === "backup") return "backup";
  const schedule = req.headers["x-vercel-cron-schedule"];
  if (schedule === DAILY_SWEEP_SCHEDULE) return "sweep";
  if (schedule === BACKUP_SCHEDULE) return "backup";
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const expectedSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error("cron: DATABASE_URL is not set");
    res.status(500).json({ error: "DATABASE_URL is not set" });
    return;
  }

  const job = resolveJob(req);
  if (job === "sweep") {
    await runDailySweep(res);
    return;
  }
  if (job === "backup") {
    await runBackupCron(res);
    return;
  }
  res.status(400).json({
    error: "cannot determine which cron job to run (expected ?job=sweep|backup, or a matching x-vercel-cron-schedule header)",
  });
}

// =====================================================================
// Daily sweep: task/reading due-date notifications + anomaly detection,
// all via push. Runs server-side against Postgres directly — never
// against Dexie.
// =====================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_WINDOW_DAYS = 7; // mirrors Tasks.tsx's own (unexported) constant

/**
 * Approximate interval -> days mapping for "is this meter's next reading
 * due". Duplicated from apps/web/src/routes/Dashboard.tsx: api/ is a
 * separate workspace that can't import from apps/web, and this table is
 * small enough that a packages/shared addition felt like more ceremony
 * than value for this feature slice — see the report for this call.
 * Calendar-approximate (monthly = 30 days, not "same day next month"),
 * not calendar-exact; an accepted v1 simplification.
 */
const READING_INTERVAL_DAYS: Record<ReadingInterval, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 91,
  yearly: 365,
};

/**
 * Per-meter-type anomaly `absoluteFloor` (docs/period-derivation.md Step 4
 * / packages/shared/src/period-derivation.ts `AnomalyOptions`). Judgment
 * call for v1: a small flat minimum in the meter's own unit, just enough
 * to stop a near-zero baseline (e.g. winter solar export near 0) from
 * making the 25% relative threshold fire on noise. Deliberately NOT
 * derived from the meter's own historical average to keep this simple —
 * flagged in the report as a reasonable place to revisit later.
 */
const ANOMALY_ABSOLUTE_FLOOR_BY_METER_TYPE: Record<MeterType, number> = {
  electricity_in: 5, // kWh
  electricity_out: 5, // kWh
  water: 1, // meter's own unit (gallons/m3/...)
  pressure: 0, // snapshot meters are excluded from anomaly detection entirely (see below)
  custom: 0,
};
/** Meter groups have no `type`, only a unit — flat floor, same reasoning as above. */
const GROUP_ANOMALY_ABSOLUTE_FLOOR = 1;

function firstOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function monthsBeforeUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1));
}

async function runDailySweep(res: VercelResponse): Promise<void> {
  const pool = getPool();

  // sendPush() throws synchronously (via its internal ensureConfigured())
  // if VAPID_* env vars are missing — check up front so a misconfigured
  // deployment degrades to "checked but couldn't send" instead of a 500.
  const pushConfigured = Boolean(
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT
  );
  if (!pushConfigured) {
    console.error("daily-sweep: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT not fully set; push disabled for this run");
  }

  const now = new Date();
  const summary = {
    tasksChecked: 0,
    tasksNotified: 0,
    readingsChecked: 0,
    readingsDueNotified: 0,
    anomalyTargetsChecked: 0,
    anomaliesNewlyFlagged: 0,
    anomaliesNotified: 0,
    pushSubscriptionsAtStart: 0,
    pushSent: 0,
    pushRemoved: 0,
    pushConfigured,
  };

  try {
    // --- push subscriptions: loaded once, mutated in place as stale ones
    // are discovered (sendPush -> shouldRemove) through the rest of the run ---
    let subs: PushSubRow[] = [];
    if (pushConfigured) {
      subs = await loadPushSubscriptions(pool);
    }
    summary.pushSubscriptionsAtStart = subs.length;

    /**
     * Attempts delivery to every current subscription (via the shared
     * server-lib helper, which mutates `subs` in place as stale ones are
     * discovered — see its doc comment for why this run reuses one array
     * across every call here instead of reloading per call). Returns
     * whether at least one delivery actually SUCCEEDED — that's what gates
     * advancing dedup state (last_notified_at / notified_at). Gating on "a
     * subscription existed when this call started" instead (an earlier
     * version of this function did that) is a real bug: a transient
     * sendPush failure (network blip, 500, 429 — anything that isn't
     * 404/410) would still permanently mark a "notify once, ever" task as
     * notified despite zero actual deliveries, silently and irrecoverably
     * losing that notification. Gating on zero subscriptions still
     * correctly avoids marking a backlog "notified" before push is ever
     * set up (delivered stays false when subs.length === 0).
     */
    async function sendToAll(payload: { title: string; body: string; url?: string }): Promise<{ delivered: boolean }> {
      const result = await sendPushToAll(pool, subs, payload);
      summary.pushSent += result.sent;
      summary.pushRemoved += result.removed;
      return { delivered: result.delivered };
    }

    // --- 1. overdue / due-soon tasks ---
    // v1 simplification (explicitly not a re-notify-every-N-days scheme,
    // per the plan): notify once per instance, ever. An instance that
    // stays overdue for weeks is not re-pushed.
    const dueSoonThreshold = new Date(now.getTime() + DUE_SOON_WINDOW_DAYS * DAY_MS);
    const { rows: taskRows } = await pool.query<{ id: string; due_date: Date; task_name: string }>(
      `SELECT ti.id, ti.due_date, tt.name AS task_name
       FROM task_instances ti
       JOIN task_templates tt ON tt.id = ti.template_id
       WHERE ti.completed_at IS NULL
         AND ti.deleted_at IS NULL
         AND tt.deleted_at IS NULL
         AND ti.last_notified_at IS NULL
         AND ti.due_date < $1
       ORDER BY ti.due_date`,
      [dueSoonThreshold.toISOString()]
    );
    summary.tasksChecked = taskRows.length;

    const notifiedTaskIds: string[] = [];
    for (const t of taskRows) {
      const overdue = t.due_date.getTime() < now.getTime();
      const { delivered } = await sendToAll({
        title: overdue ? "Overdue task" : "Task due soon",
        body: overdue
          ? `${t.task_name} is overdue (was due ${t.due_date.toISOString().slice(0, 10)}).`
          : `${t.task_name} is due ${t.due_date.toISOString().slice(0, 10)}.`,
        url: "/tasks",
      });
      if (delivered) notifiedTaskIds.push(t.id);
    }
    if (notifiedTaskIds.length > 0) {
      await pool.query(`UPDATE task_instances SET last_notified_at = now() WHERE id = ANY($1::uuid[])`, [
        notifiedTaskIds,
      ]);
      summary.tasksNotified = notifiedTaskIds.length;
    }

    // --- 2. due readings ---
    // No dedup table for this one (v1 simplification, deliberately not
    // decided silently — see report): a standing "reading is due"
    // condition will push once per day, every day, until a new reading is
    // logged. Whether that's the desired product behavior (vs. once-only
    // like tasks) is an open question flagged in the report, not resolved
    // here.
    const { rows: meterDueRows } = await pool.query<{
      id: string;
      name: string;
      reading_interval: ReadingInterval;
      last_captured_at: Date | null;
    }>(
      `SELECT m.id, m.name, m.reading_interval,
              (SELECT MAX(r.captured_at) FROM readings r WHERE r.meter_id = m.id AND r.deleted_at IS NULL) AS last_captured_at
       FROM meters m
       WHERE m.deleted_at IS NULL`
    );
    summary.readingsChecked = meterDueRows.length;

    for (const m of meterDueRows) {
      const intervalDays = READING_INTERVAL_DAYS[m.reading_interval];
      const isDue =
        m.last_captured_at == null || now.getTime() - m.last_captured_at.getTime() >= intervalDays * DAY_MS;
      if (!isDue) continue;
      const { delivered } = await sendToAll({
        title: "Meter reading due",
        body: m.last_captured_at
          ? `${m.name} hasn't been read since ${m.last_captured_at.toISOString().slice(0, 10)}.`
          : `${m.name} has never been read.`,
        url: "/meters",
      });
      if (delivered) summary.readingsDueNotified++;
    }

    // --- 3. anomalies (cumulative meters + meter groups) ---
    const rangeEnd = firstOfMonthUtc(now);
    const rangeStart = monthsBeforeUtc(rangeEnd, 4);

    async function fetchSeries(meterId: string): Promise<PeriodConsumption[]> {
      const [{ rows: readingRows }, { rows: eventRows }] = await Promise.all([
        pool.query<{ value: number; captured_at: Date }>(
          `SELECT value, captured_at FROM readings WHERE meter_id = $1 AND deleted_at IS NULL ORDER BY captured_at`,
          [meterId]
        ),
        pool.query<{ occurred_at: Date; pre_event_final_value: number; post_event_start_value: number }>(
          `SELECT occurred_at, pre_event_final_value, post_event_start_value FROM meter_events WHERE meter_id = $1 AND deleted_at IS NULL ORDER BY occurred_at`,
          [meterId]
        ),
      ]);
      const readings: ReadingPoint[] = readingRows.map((r) => ({
        capturedAt: r.captured_at.toISOString(),
        value: r.value,
      }));
      const events: MeterEventPoint[] = eventRows.map((e) => ({
        occurredAt: e.occurred_at.toISOString(),
        preEventFinalValue: e.pre_event_final_value,
        postEventStartValue: e.post_event_start_value,
      }));
      return computeMonthlySeries(readings, events, rangeStart.toISOString(), rangeEnd.toISOString());
    }

    async function checkAndFlag(
      target: { meterId: string | null; meterGroupId: string | null; label: string },
      series: PeriodConsumption[],
      absoluteFloor: number
    ): Promise<void> {
      summary.anomalyTargetsChecked++;
      if (series.length === 0) return;
      const result = checkAnomaly(series, { absoluteFloor });
      if (!result.isAnomaly || result.latest == null || result.baseline == null || result.pctOver == null) {
        return;
      }
      const period = series[series.length - 1];
      const conflictCol = target.meterId ? "meter_id" : "meter_group_id";
      const targetId = target.meterId ?? target.meterGroupId;

      // ON CONFLICT DO NOTHING: never overwrite an existing flag's
      // notified_at/acknowledged_at (see docs/period-derivation.md Step 4
      // and db/migrations/005_notifications.sql's two partial unique
      // indexes — one per target column, since a single constraint across
      // both wouldn't dedupe correctly given NULLs are distinct).
      const insertResult = await pool.query(
        `INSERT INTO anomaly_flags (${conflictCol}, period_start, period_end, computed_value, baseline_value, pct_over)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (${conflictCol}, period_start, period_end) WHERE ${conflictCol} IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [targetId, period.periodStart, period.periodEnd, result.latest, result.baseline, result.pctOver]
      );
      if ((insertResult.rowCount ?? 0) > 0) {
        summary.anomaliesNewlyFlagged++;
      }

      const { rows: flagRows } = await pool.query<{ id: string; notified_at: Date | null }>(
        `SELECT id, notified_at FROM anomaly_flags WHERE ${conflictCol} = $1 AND period_start = $2 AND period_end = $3`,
        [targetId, period.periodStart, period.periodEnd]
      );
      const flag = flagRows[0];
      if (!flag || flag.notified_at) return;

      const { delivered } = await sendToAll({
        title: "Consumption anomaly",
        body: `${target.label}: ${Math.round(result.pctOver * 100)}% above trend for ${period.periodStart.slice(0, 7)}.`,
        url: "/meters",
      });
      if (delivered) {
        await pool.query(`UPDATE anomaly_flags SET notified_at = now() WHERE id = $1`, [flag.id]);
        summary.anomaliesNotified++;
      }
    }

    const { rows: allMeters } = await pool.query<{
      id: string;
      name: string;
      type: MeterType;
      reading_kind: "cumulative" | "snapshot";
    }>(`SELECT id, name, type, reading_kind FROM meters WHERE deleted_at IS NULL`);
    const cumulativeMeters = allMeters.filter((m) => m.reading_kind === "cumulative");

    for (const m of cumulativeMeters) {
      const series = await fetchSeries(m.id);
      await checkAndFlag(
        { meterId: m.id, meterGroupId: null, label: m.name },
        series,
        ANOMALY_ABSOLUTE_FLOOR_BY_METER_TYPE[m.type]
      );
    }

    const { rows: groupMemberRows } = await pool.query<{
      group_id: string;
      group_name: string;
      meter_id: string;
      sign_multiplier: 1 | -1;
      reading_kind: "cumulative" | "snapshot";
    }>(
      `SELECT mg.id AS group_id, mg.name AS group_name, mgm.meter_id, mgm.sign_multiplier, m.reading_kind
       FROM meter_groups mg
       JOIN meter_group_members mgm ON mgm.group_id = mg.id AND mgm.deleted_at IS NULL
       JOIN meters m ON m.id = mgm.meter_id AND m.deleted_at IS NULL
       WHERE mg.deleted_at IS NULL
       ORDER BY mg.id`
    );
    const groups = new Map<string, { name: string; members: typeof groupMemberRows }>();
    for (const row of groupMemberRows) {
      const g = groups.get(row.group_id) ?? { name: row.group_name, members: [] };
      g.members.push(row);
      groups.set(row.group_id, g);
    }

    for (const [groupId, group] of groups) {
      // Period-consumption / anomaly concept only applies to cumulative
      // meters (docs/period-derivation.md) — skip a group with any
      // non-cumulative member rather than silently mis-combining it.
      if (group.members.some((m) => m.reading_kind !== "cumulative")) continue;
      const memberSeries = await Promise.all(
        group.members.map(async (m) => ({
          signMultiplier: m.sign_multiplier,
          series: await fetchSeries(m.meter_id),
        }))
      );
      const groupSeries = computeGroupSeries(memberSeries);
      await checkAndFlag(
        { meterId: null, meterGroupId: groupId, label: group.name },
        groupSeries,
        GROUP_ANOMALY_ABSOLUTE_FLOOR
      );
    }

    res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error("daily-sweep: run failed", err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "unknown error", ...summary });
  }
}

// =====================================================================
// Automated backup: weekly snapshot of the whole dataset + photos into
// Blob, with retention pruning. See packages/server-lib/src/backup.ts.
// =====================================================================

const BACKUP_RETENTION_COUNT = 8;

async function runBackupCron(res: VercelResponse): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("backup cron: BLOB_READ_WRITE_TOKEN is not set");
    res.status(500).json({ error: "BLOB_READ_WRITE_TOKEN is not set" });
    return;
  }

  const pool = getPool();
  // Same up-front check as the daily sweep: sendPush() throws synchronously
  // if VAPID_* env vars are missing.
  const pushConfigured = Boolean(
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT
  );
  if (!pushConfigured) {
    console.error("backup cron: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT not fully set; push disabled for this run");
  }

  const { rows: created } = await pool.query<BackupRow>(
    `INSERT INTO backups (kind, status) VALUES ('automated', 'running') RETURNING ${BACKUP_ROW_COLUMNS}`
  );
  const backupId = created[0].id;

  const summary = { ok: true, backupId, prunedCount: 0, pushDelivered: false };

  async function notify(title: string, body: string): Promise<void> {
    if (!pushConfigured) return;
    try {
      const subs = await loadPushSubscriptions(pool);
      const result = await sendPushToAll(pool, subs, { title, body, url: "/backups" });
      summary.pushDelivered = result.delivered;
    } catch (err) {
      console.error("backup cron: failed to send push notification", err);
    }
  }

  try {
    const { buffer, manifest } = await buildBackupArchive(pool);
    const pathname = `backups/${new Date().toISOString().replace(/[:.]/g, "-")}-automated-${backupId}.zip`;
    const blob = await put(pathname, buffer, {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/zip",
    });

    await pool.query(
      `UPDATE backups SET status = 'complete', blob_url = $1, blob_pathname = $2, size_bytes = $3,
              table_counts = $4, photo_count = $5, completed_at = now()
       WHERE id = $6`,
      [blob.url, pathname, buffer.byteLength, JSON.stringify(manifest.tableCounts), manifest.photoCount, backupId]
    );

    // Failed runs leave a row with no blob to prune, but nothing else ever
    // reaps them either — without this they'd accumulate forever. Kept
    // separate from the `complete` retention below (different query, no
    // shared OFFSET) so a backlog of failures can never push out a
    // recent, actually-usable completed backup.
    await pool.query(
      `DELETE FROM backups WHERE id IN (
         SELECT id FROM backups WHERE kind = 'automated' AND status = 'failed'
         ORDER BY created_at DESC OFFSET 5
       )`
    );

    const { rows: stale } = await pool.query<{ id: string; blob_pathname: string | null }>(
      `SELECT id, blob_pathname FROM backups
       WHERE kind = 'automated' AND status = 'complete'
       ORDER BY created_at DESC
       OFFSET $1`,
      [BACKUP_RETENTION_COUNT]
    );
    for (const row of stale) {
      if (row.blob_pathname) {
        try {
          await del(row.blob_pathname);
        } catch (err) {
          console.error(`backup cron: failed to delete stale blob ${row.blob_pathname}`, err);
        }
      }
      await pool.query("DELETE FROM backups WHERE id = $1", [row.id]);
    }
    summary.prunedCount = stale.length;

    await notify("Backup complete", `Weekly backup finished (${manifest.photoCount} photos). Tap to save a copy.`);

    res.status(200).json(summary);
  } catch (err) {
    console.error(`backup cron ${backupId} failed`, err);
    await pool.query(`UPDATE backups SET status = 'failed', error = $1, completed_at = now() WHERE id = $2`, [
      err instanceof Error ? err.message : "unknown error",
      backupId,
    ]);
    await notify("Backup failed", "The weekly automated backup failed — check the deployment logs.");
    res.status(500).json({ ok: false, backupId, error: err instanceof Error ? err.message : "unknown error" });
  }
}
