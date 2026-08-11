import type { PeriodConsumption, PeriodStats } from "./period.js";

/**
 * Pure, dependency-free implementation of docs/period-derivation.md.
 * Used both client-side (charts/overview, computed from local Dexie
 * data — no network round-trip needed) and server-side (the daily
 * anomaly cron, computed from Postgres data) — this is the ONE place
 * the algorithm is implemented; do not reimplement it in either caller.
 */

export interface ReadingPoint {
  capturedAt: string; // ISO
  value: number;
}

export interface MeterEventPoint {
  occurredAt: string; // ISO
  preEventFinalValue: number;
  postEventStartValue: number;
}

export interface DerivationOptions {
  /** Default 45 — see docs/period-derivation.md Step 1 (4a). */
  maxInterpolationGapDays?: number;
  /** Default 3 — see docs/period-derivation.md Step 1 (4b). */
  nearToleranceDays?: number;
}

const DEFAULT_OPTIONS: Required<DerivationOptions> = {
  maxInterpolationGapDays: 45,
  nearToleranceDays: 3,
};

const DAY_MS = 24 * 60 * 60 * 1000;

interface Point {
  t: number;
  value: number;
}

function toMs(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Step 1: the cumulative value at boundary instant `T`, or null if
 * genuinely undefined ("no data") — never coerce that to 0.
 */
export function deriveValueAtBoundary(
  readings: ReadingPoint[],
  events: MeterEventPoint[],
  boundaryIso: string,
  options?: DerivationOptions
): number | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const T = toMs(boundaryIso);
  const maxGapMs = opts.maxInterpolationGapDays * DAY_MS;
  const nearMs = opts.nearToleranceDays * DAY_MS;

  const sorted: Point[] = readings
    .map((r) => ({ t: toMs(r.capturedAt), value: r.value }))
    .sort((a, b) => a.t - b.t);

  let before: Point | undefined;
  let after: Point | undefined;
  for (const p of sorted) {
    if (p.t <= T) before = p;
    else if (after === undefined) after = p;
  }

  // A meter reset/replacement between before/after invalidates a direct
  // interpolation across it — split at the event instead.
  if (before && after) {
    const eventsBetween = events.filter((e) => {
      const et = toMs(e.occurredAt);
      return et > before!.t && et < after!.t;
    });
    if (eventsBetween.length > 0) {
      // Multiple events in one reading gap is a rare edge case (meter
      // replaced twice between two readings) — the nearest one to T
      // governs the split, which is the only side that matters for
      // resolving v(T).
      const event = eventsBetween.reduce((closest, e) =>
        Math.abs(toMs(e.occurredAt) - T) < Math.abs(toMs(closest.occurredAt) - T) ? e : closest
      );
      const eventT = toMs(event.occurredAt);
      if (T <= eventT) {
        after = { t: eventT, value: event.preEventFinalValue };
      } else {
        before = { t: eventT, value: event.postEventStartValue };
      }
    }
  }

  if (before && after) {
    const gap = after.t - before.t;
    if (gap <= maxGapMs) {
      if (gap === 0) return before.value;
      const frac = (T - before.t) / gap;
      return before.value + (after.value - before.value) * frac;
    }
  }

  if (before && Math.abs(T - before.t) <= nearMs) {
    return before.value;
  }

  return null;
}

/** Step 2: consumption for one period. `consumption` is null (not 0) if either boundary is undefined. */
export function computePeriodConsumption(
  readings: ReadingPoint[],
  events: MeterEventPoint[],
  periodStartIso: string,
  periodEndIso: string,
  options?: DerivationOptions
): PeriodConsumption {
  const vStart = deriveValueAtBoundary(readings, events, periodStartIso, options);
  const vEnd = deriveValueAtBoundary(readings, events, periodEndIso, options);
  return {
    periodStart: periodStartIso,
    periodEnd: periodEndIso,
    consumption: vStart == null || vEnd == null ? null : vEnd - vStart,
  };
}

/** UTC calendar-month boundaries covering [rangeStart, rangeEnd). */
export function monthBoundariesInRange(
  rangeStartIso: string,
  rangeEndIso: string
): Array<{ start: string; end: string }> {
  const start = new Date(rangeStartIso);
  const end = new Date(rangeEndIso);
  const months: Array<{ start: string; end: string }> = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor.getTime() < end.getTime()) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    months.push({ start: cursor.toISOString(), end: next.toISOString() });
    cursor = next;
  }
  return months;
}

/** Monthly consumption series covering a range — feeds month-over-year comparison, the per-meter overview, and anomaly detection. */
export function computeMonthlySeries(
  readings: ReadingPoint[],
  events: MeterEventPoint[],
  rangeStartIso: string,
  rangeEndIso: string,
  options?: DerivationOptions
): PeriodConsumption[] {
  return monthBoundariesInRange(rangeStartIso, rangeEndIso).map((m) =>
    computePeriodConsumption(readings, events, m.start, m.end, options)
  );
}

/** Step 3: stats over non-null derived monthly consumption values — never over raw cumulative readings. */
export function computePeriodStats(series: PeriodConsumption[]): PeriodStats {
  const values = series
    .map((s) => s.consumption)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);

  if (values.length === 0) {
    return { average: null, median: null, min: null, max: null, sampleCount: 0 };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  return {
    average: sum / values.length,
    median,
    min: values[0],
    max: values[values.length - 1],
    sampleCount: values.length,
  };
}

export interface AnomalyCheckResult {
  isAnomaly: boolean;
  latest: number | null;
  baseline: number | null;
  pctOver: number | null;
}

export interface AnomalyOptions {
  /** Default 0.25 — see docs/period-derivation.md Step 4. */
  pctThreshold?: number;
  /** No default — callers must pass a real per-meter-type floor; 0 disables the floor entirely. */
  absoluteFloor: number;
}

/**
 * Step 4. `orderedSeries` must be ascending by period with the latest
 * (just-completed) period last; only the last 4 entries are used (the
 * latest period plus its 3 trailing periods). Requires at least 2 of the
 * 3 trailing periods to be non-null, else no check is made.
 */
export function checkAnomaly(
  orderedSeries: PeriodConsumption[],
  options: AnomalyOptions
): AnomalyCheckResult {
  const pctThreshold = options.pctThreshold ?? 0.25;

  const latestEntry = orderedSeries[orderedSeries.length - 1];
  const latest = latestEntry ? latestEntry.consumption : null;
  const trailing = orderedSeries.slice(-4, -1);
  const trailingValues = trailing.map((s) => s.consumption).filter((v): v is number => v != null);

  if (latest == null || trailingValues.length < 2) {
    return { isAnomaly: false, latest, baseline: null, pctOver: null };
  }

  const baseline = trailingValues.reduce((a, b) => a + b, 0) / trailingValues.length;
  const pctOver = baseline !== 0 ? (latest - baseline) / baseline : null;
  const isAnomaly =
    baseline > options.absoluteFloor && pctOver != null && latest > baseline * (1 + pctThreshold);

  return { isAnomaly, latest, baseline, pctOver };
}

/** Net series for a meter group: sum(member.consumption * signMultiplier) per period, null-propagating. */
export function computeGroupSeries(
  memberSeries: Array<{ signMultiplier: 1 | -1; series: PeriodConsumption[] }>
): PeriodConsumption[] {
  if (memberSeries.length === 0) return [];
  const length = memberSeries[0].series.length;
  const result: PeriodConsumption[] = [];
  for (let i = 0; i < length; i++) {
    const { periodStart, periodEnd } = memberSeries[0].series[i];
    let sum = 0;
    let anyNull = false;
    for (const m of memberSeries) {
      const c = m.series[i]?.consumption;
      if (c == null) {
        anyNull = true;
        break;
      }
      sum += c * m.signMultiplier;
    }
    result.push({ periodStart, periodEnd, consumption: anyNull ? null : sum });
  }
  return result;
}
