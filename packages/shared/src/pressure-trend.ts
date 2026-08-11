/**
 * Pure, dependency-free warning logic for a meter's optional
 * `minThreshold`/`maxThreshold` (see `meter.ts`). Used client-side only
 * for v1 (dashboard display + MeterDetail chart) — see
 * docs/period-derivation.md "Pressure thresholds & decline trend" for
 * the algorithm this implements. Not wired into the server-side daily
 * cron / push notifications (that's out of scope for v1).
 */

export interface ThresholdReadingPoint {
  capturedAt: string; // ISO
  value: number;
}

export type PressureStatus =
  | "no_data"
  | "no_thresholds"
  | "ok"
  | "approaching_min"
  | "approaching_max"
  | "below_min"
  | "above_max";

export interface PressureTrendResult {
  latestValue: number | null;
  latestCapturedAt: string | null;
  /** Least-squares slope of value over time, in units/day. Null if fewer than `minPointsForTrend` readings in the trend window, or if they all share one timestamp. */
  slopePerDay: number | null;
  status: PressureStatus;
  /** Set only for "approaching_min"/"approaching_max". */
  predictedCrossingAt: string | null;
  daysUntilCrossing: number | null;
}

export interface PressureTrendOptions {
  /** How many of the most recent readings to fit the trend line to. Default 10. */
  trendWindowSize?: number;
  /** Minimum readings (within the window) required to compute a trend at all. Default 3. */
  minPointsForTrend?: number;
  /** Only surface "approaching_*" if the predicted crossing is within this many days. Default 30. */
  warnWithinDays?: number;
}

const DEFAULT_OPTIONS: Required<PressureTrendOptions> = {
  trendWindowSize: 10,
  minPointsForTrend: 3,
  warnWithinDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Least-squares slope (units/day) of `value` against `capturedAt`, or null if underdetermined. */
function computeSlopePerDay(points: ThresholdReadingPoint[]): number | null {
  if (points.length < 2) return null;
  const t0 = new Date(points[0].capturedAt).getTime();
  const xs = points.map((p) => (new Date(p.capturedAt).getTime() - t0) / DAY_MS);
  const ys = points.map((p) => p.value);
  const n = points.length;
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  if (den === 0) return null; // all readings at the same instant
  return num / den;
}

/**
 * Evaluates a meter's current status against its optional min/max
 * thresholds and, if it's trending toward one, predicts when it will
 * cross it. `readings` need not be sorted or deduplicated.
 */
export function computePressureTrend(
  readings: ThresholdReadingPoint[],
  minThreshold: number | null,
  maxThreshold: number | null,
  options?: PressureTrendOptions
): PressureTrendResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const empty: PressureTrendResult = {
    latestValue: null,
    latestCapturedAt: null,
    slopePerDay: null,
    status: "no_data",
    predictedCrossingAt: null,
    daysUntilCrossing: null,
  };
  if (readings.length === 0) return empty;

  const sorted = [...readings].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const latest = sorted[sorted.length - 1];
  const window = sorted.slice(-opts.trendWindowSize);
  const slopePerDay = window.length >= opts.minPointsForTrend ? computeSlopePerDay(window) : null;

  const hasThresholds = minThreshold != null || maxThreshold != null;

  if (minThreshold != null && latest.value <= minThreshold) {
    return {
      latestValue: latest.value,
      latestCapturedAt: latest.capturedAt,
      slopePerDay,
      status: "below_min",
      predictedCrossingAt: null,
      daysUntilCrossing: null,
    };
  }
  if (maxThreshold != null && latest.value >= maxThreshold) {
    return {
      latestValue: latest.value,
      latestCapturedAt: latest.capturedAt,
      slopePerDay,
      status: "above_max",
      predictedCrossingAt: null,
      daysUntilCrossing: null,
    };
  }

  if (slopePerDay != null) {
    if (minThreshold != null && slopePerDay < 0) {
      const days = (minThreshold - latest.value) / slopePerDay;
      if (days > 0 && days <= opts.warnWithinDays) {
        return {
          latestValue: latest.value,
          latestCapturedAt: latest.capturedAt,
          slopePerDay,
          status: "approaching_min",
          predictedCrossingAt: new Date(new Date(latest.capturedAt).getTime() + days * DAY_MS).toISOString(),
          daysUntilCrossing: days,
        };
      }
    }
    if (maxThreshold != null && slopePerDay > 0) {
      const days = (maxThreshold - latest.value) / slopePerDay;
      if (days > 0 && days <= opts.warnWithinDays) {
        return {
          latestValue: latest.value,
          latestCapturedAt: latest.capturedAt,
          slopePerDay,
          status: "approaching_max",
          predictedCrossingAt: new Date(new Date(latest.capturedAt).getTime() + days * DAY_MS).toISOString(),
          daysUntilCrossing: days,
        };
      }
    }
  }

  return {
    latestValue: latest.value,
    latestCapturedAt: latest.capturedAt,
    slopePerDay,
    status: hasThresholds ? "ok" : "no_thresholds",
    predictedCrossingAt: null,
    daysUntilCrossing: null,
  };
}
