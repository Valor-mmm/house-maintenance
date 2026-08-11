import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import type { MeterType, Reading, ReadingInterval } from "@house/shared";
import { db } from "../db/dexie";
import GaugeTile from "../components/GaugeTile";
import StatusRow, { type StatusRowProps } from "../components/StatusRow";
import { fetchUnacknowledgedAnomalies, type AnomalyFlagWithTarget } from "../data/anomalies";
import { enablePushNotifications } from "../data/push";

const METERS_COLLAPSED_KEY = "dashboard.metersCollapsed";

const METER_TYPE_LABELS: Record<MeterType, string> = {
  electricity_in: "Electricity (in)",
  electricity_out: "Electricity (out)",
  water: "Water",
  pressure: "Pressure",
  custom: "Custom",
};

function formatValue(n: number, digits = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

// Owned by the "Dashboard + push notification cron" feature slice. Visual
// structure/components (GaugeTile, StatusRow) are the approved design
// pass and are kept as-is — see the approved plan, Feature Scope #4.

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_WINDOW_DAYS = 7; // mirrors Tasks.tsx's own (unexported) constant

/**
 * Approximate interval -> days mapping for "is this meter's next reading
 * due". This is not calendar-exact (e.g. "monthly" = 30 days, not "same
 * day next month") — an accepted v1 simplification. Also used
 * server-side by the daily cron (api/cron/daily-sweep.ts), which can't
 * import from apps/web — duplicated there with a cross-reference comment
 * back to this file; keep the two in sync if this table ever changes.
 */
const READING_INTERVAL_DAYS: Record<ReadingInterval, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 91,
  yearly: 365,
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / DAY_MS);
}

interface AttentionRow extends StatusRowProps {
  key: string;
}

export default function Dashboard() {
  const now = Date.now();

  const taskInstances = useLiveQuery(
    () => db.taskInstances.filter((t) => t.completedAt == null && t.deletedAt == null).toArray(),
    []
  );
  const taskTemplates = useLiveQuery(() => db.taskTemplates.filter((t) => t.deletedAt == null).toArray(), []);
  const meters = useLiveQuery(() => db.meters.filter((m) => m.deletedAt == null).toArray(), []);
  const readings = useLiveQuery(() => db.readings.filter((r) => r.deletedAt == null).toArray(), []);

  const [anomalies, setAnomalies] = useState<AnomalyFlagWithTarget[] | null>(null);
  const [anomaliesError, setAnomaliesError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchUnacknowledgedAnomalies()
      .then((data) => {
        if (!cancelled) setAnomalies(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setAnomaliesError(err instanceof Error ? err.message : "Failed to load anomalies.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const templateById = useMemo(() => {
    const map = new Map<string, { name: string; category: string }>();
    for (const t of taskTemplates ?? []) map.set(t.id, { name: t.name, category: t.category });
    return map;
  }, [taskTemplates]);

  const overdueTasks = useMemo(
    () => (taskInstances ?? []).filter((t) => new Date(t.dueDate).getTime() < now),
    [taskInstances, now]
  );
  const dueSoonTasks = useMemo(() => {
    const soonThreshold = now + DUE_SOON_WINDOW_DAYS * DAY_MS;
    return (taskInstances ?? []).filter((t) => {
      const due = new Date(t.dueDate).getTime();
      return due >= now && due <= soonThreshold;
    });
  }, [taskInstances, now]);

  // Latest reading per meter, from the local reading history.
  const latestReadingByMeter = useMemo(() => {
    const map = new Map<string, Reading>();
    for (const r of readings ?? []) {
      const existing = map.get(r.meterId);
      if (!existing || r.capturedAt > existing.capturedAt) map.set(r.meterId, r);
    }
    return map;
  }, [readings]);

  const dueMeters = useMemo(() => {
    return (meters ?? []).filter((m) => {
      const last = latestReadingByMeter.get(m.id);
      if (!last) return true; // never read -> due
      const intervalDays = READING_INTERVAL_DAYS[m.readingInterval];
      return now - new Date(last.capturedAt).getTime() >= intervalDays * DAY_MS;
    });
  }, [meters, latestReadingByMeter, now]);

  const sortedMeters = useMemo(() => [...(meters ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [meters]);

  const [metersCollapsed, setMetersCollapsed] = useState(() => localStorage.getItem(METERS_COLLAPSED_KEY) === "1");

  function toggleMetersCollapsed() {
    setMetersCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem(METERS_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }

  const overdueCount = overdueTasks.length + dueMeters.length;
  const dueSoonCount = dueSoonTasks.length;
  const anomalyCount = anomalies?.length ?? 0;

  const attentionRows: AttentionRow[] = [
    ...overdueTasks.map((t): AttentionRow => {
      const meta = templateById.get(t.templateId);
      const overDays = daysBetween(new Date(t.dueDate).getTime(), now);
      return {
        key: `task-${t.id}`,
        title: meta?.name ?? "Task",
        meta: `Overdue${meta?.category ? ` · ${meta.category}` : ""}`,
        tone: "danger",
        trailing: `${overDays}d over`,
      };
    }),
    ...dueMeters.map((m): AttentionRow => {
      const last = latestReadingByMeter.get(m.id);
      return {
        key: `reading-${m.id}`,
        title: `${m.name} reading`,
        meta: `Reading due · ${m.type}`,
        tone: "danger",
        trailing: last ? `${daysBetween(new Date(last.capturedAt).getTime(), now)}d since last` : "never read",
      };
    }),
    ...dueSoonTasks.map((t): AttentionRow => {
      const meta = templateById.get(t.templateId);
      return {
        key: `task-${t.id}`,
        title: meta?.name ?? "Task",
        meta: `Due soon${meta?.category ? ` · ${meta.category}` : ""}`,
        tone: "warn",
        trailing: `due ${formatDate(t.dueDate)}`,
      };
    }),
    ...(anomalies ?? []).map((a): AttentionRow => {
      const pct = Math.round(a.pctOver * 100);
      const periodLabel = new Date(a.periodStart).toLocaleDateString(undefined, { year: "numeric", month: "short" });
      return {
        key: `anomaly-${a.id}`,
        title: `${a.targetName} consumption ${pct}% above trend`,
        meta: `Anomaly · ${periodLabel}`,
        tone: "accent",
        trailing: "review",
      };
    }),
  ];

  return (
    <div className="max-w-3xl md:max-w-5xl mx-auto px-4 pt-8 pb-4 md:pt-12">
      <header className="mb-6">
        <div className="label-plate">House Maintenance</div>
        <h1 className="font-display italic text-3xl md:text-4xl mt-1">My House</h1>
      </header>

      <div className="tick-rule mb-6" />

      <NotificationEnableControl />

      <div className="md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-8 md:items-start">
        <section aria-label="Overview" className="grid grid-cols-3 gap-3 mb-8 md:mb-0">
          <GaugeTile label="Overdue" value={overdueCount} max={Math.max(overdueCount, 6)} tone="danger" />
          <GaugeTile label="Due soon" value={dueSoonCount} max={Math.max(dueSoonCount, 6)} tone="warn" />
          <GaugeTile label="Anomalies" value={anomalyCount} max={Math.max(anomalyCount, 4)} tone="accent" />
        </section>

        <section aria-label="Needs attention">
          <div className="label-plate mb-1">Needs attention</div>
          {anomaliesError && (
            <p className="text-sm text-danger mb-2">Anomalies couldn't be loaded: {anomaliesError}</p>
          )}
          <div className="divide-y divide-border border-t border-b border-border">
            {attentionRows.length === 0 ? (
              <StatusRow title="All caught up" meta="No overdue tasks, due readings, or anomalies" tone="muted" trailing="on track" />
            ) : (
              attentionRows.map(({ key, ...row }) => <StatusRow key={key} {...row} />)
            )}
          </div>
        </section>
      </div>

      <section aria-label="Meters overview" className="mt-8">
        <button
          type="button"
          onClick={toggleMetersCollapsed}
          aria-expanded={!metersCollapsed}
          className="w-full flex items-center justify-between gap-3 label-plate hover:text-accent-strong"
        >
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block transition-transform"
              style={{ transform: metersCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
              aria-hidden="true"
            >
              ▾
            </span>
            Meters{meters ? ` (${meters.length})` : ""}
          </span>
          <span className="text-muted">{metersCollapsed ? "Show" : "Hide"}</span>
        </button>

        {!metersCollapsed && (
          <div className="divide-y divide-border border-t border-b border-border mt-1">
            {meters === undefined ? (
              <div className="text-muted text-sm py-3">Loading…</div>
            ) : sortedMeters.length === 0 ? (
              <div className="text-muted text-sm py-3">No meters yet.</div>
            ) : (
              sortedMeters.map((m) => {
                const last = latestReadingByMeter.get(m.id);
                return (
                  <Link key={m.id} to={`/meters/${m.id}`} className="block hover:bg-surface">
                    <StatusRow
                      title={m.name}
                      meta={`${METER_TYPE_LABELS[m.type]} · ${last ? `last read ${formatDate(last.capturedAt)}` : "never read"}`}
                      tone={dueMeters.some((d) => d.id === m.id) ? "danger" : "muted"}
                      trailing={last ? `${formatValue(last.value)} ${m.unit}` : "—"}
                    />
                  </Link>
                );
              })
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Small, unobtrusive prompt to subscribe to push (see
 * apps/web/src/data/push.ts). Only shown while permission isn't already
 * "granted" — once granted there's nothing left to ask for. Kept
 * self-contained here rather than in App.tsx per the hard rule to leave
 * that file's existing structure alone.
 */
function NotificationEnableControl() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (permission === "granted" || permission === "unsupported") return null;

  async function handleEnable() {
    setWorking(true);
    setError(null);
    const result = await enablePushNotifications();
    setWorking(false);
    if (result.ok) {
      setPermission(typeof Notification !== "undefined" ? Notification.permission : "unsupported");
    } else {
      setError(result.reason);
    }
  }

  return (
    <div className="border border-border bg-surface px-4 py-3 flex items-center gap-4 mb-6">
      <div className="flex-1 min-w-0">
        <div className="label-plate">Notifications</div>
        <p className="text-sm mt-0.5">Get a push alert for overdue tasks, due readings, and consumption anomalies.</p>
        {error && <p className="text-sm mt-1 text-danger">{error}</p>}
      </div>
      <button
        type="button"
        onClick={handleEnable}
        disabled={working}
        className="border border-accent-strong bg-accent text-surface font-mono text-xs tracking-wide px-3 py-2 hover:bg-accent-strong transition-colors shrink-0 disabled:opacity-50"
      >
        {working ? "Enabling…" : "Enable notifications"}
      </button>
    </div>
  );
}
