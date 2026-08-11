import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { computePressureTrend, type MeterType, type Reading, type ReadingInterval } from "@house/shared";
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

const METER_TONE_VAR: Record<"good" | "warn" | "danger" | "muted", string> = {
  good: "var(--color-good)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
  muted: "var(--color-text-muted)",
};

function formatValue(n: number, digits = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** Small line-icon per meter type — same thin-stroke, no-fill vocabulary as GaugeTile's dial. */
function MeterTypeIcon({ type }: { type: MeterType }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (type) {
    case "electricity_in":
    case "electricity_out":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
        </svg>
      );
    case "water":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M12 3s7 7.4 7 12a7 7 0 1 1-14 0c0-4.6 7-12 7-12z" />
        </svg>
      );
    case "pressure":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="12" cy="13" r="8" />
          <path d="M12 13 16 9" />
          <path d="M9 5h6" />
        </svg>
      );
    case "custom":
    default:
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
  }
}

/** Hand-rolled trend line for the last few readings — deliberately not recharts (too heavy for a tile-sized multiple). */
function Sparkline({ values, tone }: { values: number[]; tone: "good" | "warn" | "danger" | "muted" }) {
  const w = 96;
  const h = 28;
  if (values.length < 2) {
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        <line x1={4} y1={h / 2} x2={w - 4} y2={h / 2} stroke="var(--color-border)" strokeWidth={1} strokeDasharray="2 3" />
      </svg>
    );
  }
  const pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y] as const;
  });
  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = points[points.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={path} fill="none" stroke={METER_TONE_VAR[tone]} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={2} fill={METER_TONE_VAR[tone]} />
    </svg>
  );
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

  // Per-meter reading history, oldest first, for the dashboard sparklines.
  const readingsByMeter = useMemo(() => {
    const map = new Map<string, Reading[]>();
    for (const r of readings ?? []) {
      const arr = map.get(r.meterId);
      if (arr) arr.push(r);
      else map.set(r.meterId, [r]);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    return map;
  }, [readings]);

  // Pressure (or any meter with a min/max threshold) warning status — see
  // packages/shared/src/pressure-trend.ts and docs/period-derivation.md
  // "Pressure thresholds & decline trend". Computed client-side from the
  // reading history already loaded above; not synced/server-side for v1.
  const pressureStatusByMeter = useMemo(() => {
    const map = new Map<string, ReturnType<typeof computePressureTrend>>();
    for (const m of meters ?? []) {
      if (m.minThreshold == null && m.maxThreshold == null) continue;
      map.set(m.id, computePressureTrend(readingsByMeter.get(m.id) ?? [], m.minThreshold, m.maxThreshold));
    }
    return map;
  }, [meters, readingsByMeter]);

  const [metersCollapsed, setMetersCollapsed] = useState(() => localStorage.getItem(METERS_COLLAPSED_KEY) === "1");

  function toggleMetersCollapsed() {
    setMetersCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem(METERS_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }

  const pressureWarningMeters = useMemo(
    () =>
      (meters ?? []).filter((m) => {
        const status = pressureStatusByMeter.get(m.id)?.status;
        return status === "below_min" || status === "above_max" || status === "approaching_min" || status === "approaching_max";
      }),
    [meters, pressureStatusByMeter]
  );

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
    ...pressureWarningMeters.map((m): AttentionRow => {
      const result = pressureStatusByMeter.get(m.id)!;
      const danger = result.status === "below_min" || result.status === "above_max";
      const trailing =
        result.status === "below_min" || result.status === "above_max"
          ? `${formatValue(result.latestValue ?? 0)} ${m.unit}`
          : `≈${Math.round(result.daysUntilCrossing ?? 0)}d to ${result.status === "approaching_min" ? "min" : "max"}`;
      return {
        key: `pressure-${m.id}`,
        title: `${m.name} ${danger ? "out of range" : "trending toward limit"}`,
        meta: `Pressure · ${m.type}`,
        tone: danger ? "danger" : "warn",
        trailing,
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
          <>
            {meters === undefined ? (
              <div className="text-muted text-sm py-3">Loading…</div>
            ) : sortedMeters.length === 0 ? (
              <div className="text-muted text-sm py-3">No meters yet.</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                {sortedMeters.map((m) => {
                  const last = latestReadingByMeter.get(m.id);
                  const pressureStatus = pressureStatusByMeter.get(m.id)?.status;
                  const pressureDanger = pressureStatus === "below_min" || pressureStatus === "above_max";
                  const pressureWarn = pressureStatus === "approaching_min" || pressureStatus === "approaching_max";
                  const tone = pressureDanger || dueMeters.some((d) => d.id === m.id) ? "danger" : pressureWarn ? "warn" : "good";
                  const history = (readingsByMeter.get(m.id) ?? []).slice(-8).map((r) => r.value);
                  return (
                    <Link
                      key={m.id}
                      to={`/meters/${m.id}`}
                      className="group block border border-border bg-surface p-3 hover:border-accent transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 text-muted group-hover:text-accent-strong transition-colors">
                          <MeterTypeIcon type={m.type} />
                          <div className="min-w-0">
                            <div className="truncate text-ink">{m.name}</div>
                            <div className="label-plate">{METER_TYPE_LABELS[m.type]}</div>
                          </div>
                        </div>
                        <span
                          className="w-2 h-2 rounded-full shrink-0 mt-1"
                          style={{ backgroundColor: METER_TONE_VAR[tone] }}
                          title={pressureDanger ? "Out of range" : pressureWarn ? "Trending toward limit" : tone === "danger" ? "Reading due" : "On track"}
                        />
                      </div>

                      <div className="mt-3 flex items-end justify-between gap-2">
                        <div className="font-mono">
                          <span className="text-2xl leading-none">{last ? formatValue(last.value) : "—"}</span>
                          {last && <span className="text-muted text-xs ml-1">{m.unit}</span>}
                        </div>
                        <Sparkline values={history} tone={tone} />
                      </div>

                      <div className="label-plate mt-2 text-muted">
                        {last ? `Last read ${formatDate(last.capturedAt)}` : "Never read"}
                      </div>
                      {pressureWarn && (
                        <div className="label-plate mt-1" style={{ color: "var(--color-warn)" }}>
                          ≈{Math.round(pressureStatusByMeter.get(m.id)!.daysUntilCrossing ?? 0)}d to{" "}
                          {pressureStatus === "approaching_min" ? "min" : "max"}
                        </div>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </>
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
