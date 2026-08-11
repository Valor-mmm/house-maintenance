import { describe, it, expect } from "vitest";
import { computePressureTrend, type ThresholdReadingPoint } from "./pressure-trend.js";

function daysAgo(n: number, from = "2025-06-01T00:00:00.000Z"): string {
  return new Date(new Date(from).getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("computePressureTrend", () => {
  it("returns no_data for an empty reading history", () => {
    const result = computePressureTrend([], 1.0, 2.5);
    expect(result.status).toBe("no_data");
    expect(result.latestValue).toBeNull();
  });

  it("returns no_thresholds when neither bound is set, but still reports the latest value", () => {
    const readings: ThresholdReadingPoint[] = [{ capturedAt: daysAgo(0), value: 1.8 }];
    const result = computePressureTrend(readings, null, null);
    expect(result.status).toBe("no_thresholds");
    expect(result.latestValue).toBe(1.8);
  });

  it("flags below_min when the latest reading is already at or under the minimum", () => {
    const readings: ThresholdReadingPoint[] = [
      { capturedAt: daysAgo(10), value: 1.5 },
      { capturedAt: daysAgo(0), value: 0.9 },
    ];
    const result = computePressureTrend(readings, 1.0, 2.5);
    expect(result.status).toBe("below_min");
    expect(result.daysUntilCrossing).toBeNull();
  });

  it("flags above_max when the latest reading is already at or over the maximum", () => {
    const readings: ThresholdReadingPoint[] = [{ capturedAt: daysAgo(0), value: 3.0 }];
    const result = computePressureTrend(readings, 1.0, 2.5);
    expect(result.status).toBe("above_max");
  });

  it("predicts a crossing date when a declining trend is heading toward the minimum within the warning window", () => {
    // Losing 0.1/day, starting at 2.0 -> minThreshold 1.0 reached in 10 days.
    const readings: ThresholdReadingPoint[] = [
      { capturedAt: daysAgo(30), value: 5.0 },
      { capturedAt: daysAgo(20), value: 4.0 },
      { capturedAt: daysAgo(10), value: 3.0 },
      { capturedAt: daysAgo(0), value: 2.0 },
    ];
    const result = computePressureTrend(readings, 1.0, null, { warnWithinDays: 30 });
    expect(result.status).toBe("approaching_min");
    expect(result.slopePerDay).toBeCloseTo(-0.1, 5);
    expect(result.daysUntilCrossing).toBeCloseTo(10, 0);
  });

  it("does not warn when the predicted crossing falls outside warnWithinDays", () => {
    const readings: ThresholdReadingPoint[] = [
      { capturedAt: daysAgo(30), value: 2.3 },
      { capturedAt: daysAgo(20), value: 2.2 },
      { capturedAt: daysAgo(10), value: 2.1 },
      { capturedAt: daysAgo(0), value: 2.0 },
    ];
    const result = computePressureTrend(readings, 1.0, null, { warnWithinDays: 5 });
    expect(result.status).toBe("ok");
    expect(result.daysUntilCrossing).toBeNull();
  });

  it("does not warn when trending away from the only set threshold", () => {
    const readings: ThresholdReadingPoint[] = [
      { capturedAt: daysAgo(20), value: 1.5 },
      { capturedAt: daysAgo(10), value: 1.8 },
      { capturedAt: daysAgo(0), value: 2.1 },
    ];
    const result = computePressureTrend(readings, 1.0, null);
    expect(result.status).toBe("ok");
  });

  it("returns ok (not a prediction) when there are fewer than minPointsForTrend readings", () => {
    const readings: ThresholdReadingPoint[] = [
      { capturedAt: daysAgo(10), value: 2.2 },
      { capturedAt: daysAgo(0), value: 2.0 },
    ];
    const result = computePressureTrend(readings, 1.0, 2.5);
    expect(result.slopePerDay).toBeNull();
    expect(result.status).toBe("ok");
  });

  it("predicts a crossing toward the maximum on a rising trend", () => {
    const readings: ThresholdReadingPoint[] = [
      { capturedAt: daysAgo(20), value: 1.8 },
      { capturedAt: daysAgo(10), value: 2.0 },
      { capturedAt: daysAgo(0), value: 2.2 },
    ];
    const result = computePressureTrend(readings, null, 2.5, { warnWithinDays: 30 });
    expect(result.status).toBe("approaching_max");
    expect(result.daysUntilCrossing).toBeGreaterThan(0);
  });

  it("only fits the trend to the most recent trendWindowSize readings", () => {
    // An old rising run, followed by a recent, steeper decline — the
    // trend should reflect only the recent decline, not be diluted by
    // the stale rising readings outside the window.
    const readings: ThresholdReadingPoint[] = [
      { capturedAt: daysAgo(100), value: 1.0 },
      { capturedAt: daysAgo(90), value: 1.5 },
      { capturedAt: daysAgo(80), value: 2.0 },
      { capturedAt: daysAgo(9), value: 2.3 },
      { capturedAt: daysAgo(6), value: 2.2 },
      { capturedAt: daysAgo(3), value: 2.1 },
      { capturedAt: daysAgo(0), value: 2.0 },
    ];
    const result = computePressureTrend(readings, 1.0, null, { trendWindowSize: 4, warnWithinDays: 60 });
    expect(result.slopePerDay).toBeLessThan(0);
    expect(result.status).toBe("approaching_min");
  });
});
