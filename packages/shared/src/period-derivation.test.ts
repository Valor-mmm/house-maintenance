import { describe, it, expect } from "vitest";
import {
  deriveValueAtBoundary,
  computePeriodConsumption,
  monthBoundariesInRange,
  computeMonthlySeries,
  computePeriodStats,
  checkAnomaly,
  computeGroupSeries,
  type ReadingPoint,
  type MeterEventPoint,
} from "./period-derivation.js";
import type { PeriodConsumption } from "./period.js";

describe("deriveValueAtBoundary", () => {
  const readings: ReadingPoint[] = [
    { capturedAt: "2024-01-01T00:00:00.000Z", value: 100 },
    { capturedAt: "2024-01-11T00:00:00.000Z", value: 200 },
  ];

  it("interpolates linearly between two readings that straddle the boundary", () => {
    // Halfway between Jan 1 (100) and Jan 11 (200) -> Jan 6 -> 150
    const v = deriveValueAtBoundary(readings, [], "2024-01-06T00:00:00.000Z");
    expect(v).toBe(150);
  });

  it("returns the exact reading value when the gap between before/after is zero", () => {
    const sameInstant: ReadingPoint[] = [
      { capturedAt: "2024-01-01T00:00:00.000Z", value: 42 },
      { capturedAt: "2024-01-01T00:00:00.000Z", value: 42 },
    ];
    expect(deriveValueAtBoundary(sameInstant, [], "2024-01-01T00:00:00.000Z")).toBe(42);
  });

  it("returns null when the gap between before/after exceeds maxInterpolationGapDays", () => {
    const farApart: ReadingPoint[] = [
      { capturedAt: "2024-01-01T00:00:00.000Z", value: 100 },
      { capturedAt: "2024-03-01T00:00:00.000Z", value: 200 }, // ~60 days, default max is 45
    ];
    const v = deriveValueAtBoundary(farApart, [], "2024-02-01T00:00:00.000Z");
    expect(v).toBeNull();
  });

  it("falls back to the nearest reading within nearToleranceDays when there's no 'after' point", () => {
    const v = deriveValueAtBoundary(readings, [], "2024-01-12T12:00:00.000Z");
    expect(v).toBe(200); // within 3 days of the Jan 11 reading, no later reading exists
  });

  it("returns null when there's no reading within nearToleranceDays and no 'after' point", () => {
    const v = deriveValueAtBoundary(readings, [], "2024-02-01T00:00:00.000Z");
    expect(v).toBeNull();
  });

  it("returns null when there is no 'before' reading at all", () => {
    const v = deriveValueAtBoundary(readings, [], "2023-01-01T00:00:00.000Z");
    expect(v).toBeNull();
  });

  it("splits at a meter-replacement event instead of interpolating across it", () => {
    const events: MeterEventPoint[] = [
      {
        occurredAt: "2024-01-06T00:00:00.000Z",
        preEventFinalValue: 999,
        postEventStartValue: 0,
      },
    ];
    // Boundary just before the event -> use the pre-event side (before=100, after=999 at event time)
    const beforeEvent = deriveValueAtBoundary(readings, events, "2024-01-05T00:00:00.000Z");
    // interpolate 100 -> 999 over Jan1..Jan6 (5 days), at Jan5 (4/5 of the way)
    expect(beforeEvent).toBeCloseTo(100 + (999 - 100) * (4 / 5), 5);

    // Boundary just after the event -> use the post-event side (before=0 at event time, after=200 at Jan11)
    const afterEvent = deriveValueAtBoundary(readings, events, "2024-01-07T00:00:00.000Z");
    // interpolate 0 -> 200 over Jan6..Jan11 (5 days), at Jan7 (1/5 of the way)
    expect(afterEvent).toBeCloseTo(0 + (200 - 0) * (1 / 5), 5);
  });
});

describe("computePeriodConsumption", () => {
  const readings: ReadingPoint[] = [
    { capturedAt: "2024-01-01T00:00:00.000Z", value: 100 },
    { capturedAt: "2024-02-01T00:00:00.000Z", value: 150 },
  ];

  it("computes consumption as end minus start when both boundaries resolve", () => {
    const result = computePeriodConsumption(
      readings,
      [],
      "2024-01-01T00:00:00.000Z",
      "2024-02-01T00:00:00.000Z"
    );
    expect(result.consumption).toBe(50);
  });

  it("returns null consumption (never 0) when a boundary is undefined", () => {
    const result = computePeriodConsumption(
      readings,
      [],
      "2023-01-01T00:00:00.000Z", // far before any reading, and not within tolerance
      "2024-01-01T00:00:00.000Z"
    );
    expect(result.consumption).toBeNull();
  });
});

describe("monthBoundariesInRange", () => {
  it("returns one entry per UTC calendar month covering the range", () => {
    const months = monthBoundariesInRange("2024-01-15T00:00:00.000Z", "2024-04-01T00:00:00.000Z");
    expect(months).toEqual([
      { start: "2024-01-01T00:00:00.000Z", end: "2024-02-01T00:00:00.000Z" },
      { start: "2024-02-01T00:00:00.000Z", end: "2024-03-01T00:00:00.000Z" },
      { start: "2024-03-01T00:00:00.000Z", end: "2024-04-01T00:00:00.000Z" },
    ]);
  });

  it("returns the containing month even for a sub-day range within it", () => {
    const months = monthBoundariesInRange("2024-01-31T23:00:00.000Z", "2024-01-31T23:30:00.000Z");
    expect(months).toEqual([{ start: "2024-01-01T00:00:00.000Z", end: "2024-02-01T00:00:00.000Z" }]);
  });

  it("returns an empty array when the range end is at or before the start of its own month", () => {
    const months = monthBoundariesInRange("2024-01-15T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
    expect(months).toEqual([]);
  });
});

describe("computeMonthlySeries", () => {
  it("derives one consumption entry per month in range", () => {
    const readings: ReadingPoint[] = [
      { capturedAt: "2024-01-01T00:00:00.000Z", value: 0 },
      { capturedAt: "2024-02-01T00:00:00.000Z", value: 100 },
      { capturedAt: "2024-03-01T00:00:00.000Z", value: 250 },
    ];
    const series = computeMonthlySeries(
      readings,
      [],
      "2024-01-01T00:00:00.000Z",
      "2024-03-01T00:00:00.000Z"
    );
    expect(series).toHaveLength(2);
    expect(series[0].consumption).toBe(100);
    expect(series[1].consumption).toBe(150);
  });
});

describe("computePeriodStats", () => {
  it("computes average/median/min/max over non-null values only", () => {
    const series: PeriodConsumption[] = [
      { periodStart: "a", periodEnd: "b", consumption: 10 },
      { periodStart: "b", periodEnd: "c", consumption: null },
      { periodStart: "c", periodEnd: "d", consumption: 20 },
      { periodStart: "d", periodEnd: "e", consumption: 30 },
    ];
    const stats = computePeriodStats(series);
    expect(stats).toEqual({ average: 20, median: 20, min: 10, max: 30, sampleCount: 3 });
  });

  it("averages the two middle values for an even sample count", () => {
    const series: PeriodConsumption[] = [
      { periodStart: "a", periodEnd: "b", consumption: 10 },
      { periodStart: "b", periodEnd: "c", consumption: 20 },
    ];
    expect(computePeriodStats(series).median).toBe(15);
  });

  it("returns all-null stats with sampleCount 0 when every value is null", () => {
    const series: PeriodConsumption[] = [{ periodStart: "a", periodEnd: "b", consumption: null }];
    expect(computePeriodStats(series)).toEqual({
      average: null,
      median: null,
      min: null,
      max: null,
      sampleCount: 0,
    });
  });
});

describe("checkAnomaly", () => {
  function series(values: Array<number | null>): PeriodConsumption[] {
    return values.map((v, i) => ({
      periodStart: `p${i}-start`,
      periodEnd: `p${i}-end`,
      consumption: v,
    }));
  }

  it("flags an anomaly when the latest period exceeds the trailing baseline by more than the threshold", () => {
    // trailing baseline = (100 + 100 + 100) / 3 = 100; latest = 200 -> +100% > default 25%
    const result = checkAnomaly(series([100, 100, 100, 200]), { absoluteFloor: 0 });
    expect(result.isAnomaly).toBe(true);
    expect(result.baseline).toBe(100);
    expect(result.latest).toBe(200);
    expect(result.pctOver).toBeCloseTo(1, 5);
  });

  it("does not flag when latest is within threshold of the baseline", () => {
    const result = checkAnomaly(series([100, 100, 100, 110]), { absoluteFloor: 0 });
    expect(result.isAnomaly).toBe(false);
  });

  it("does not flag when the baseline is at or below the absolute floor", () => {
    const result = checkAnomaly(series([1, 1, 1, 10]), { absoluteFloor: 5 });
    expect(result.isAnomaly).toBe(false);
  });

  it("makes no check when fewer than 2 of the 3 trailing periods are non-null", () => {
    const result = checkAnomaly(series([null, null, 100, 500]), { absoluteFloor: 0 });
    expect(result.isAnomaly).toBe(false);
    expect(result.baseline).toBeNull();
  });

  it("makes no check when the latest period itself is null", () => {
    const result = checkAnomaly(series([100, 100, 100, null]), { absoluteFloor: 0 });
    expect(result.isAnomaly).toBe(false);
    expect(result.latest).toBeNull();
  });

  it("only considers the last 4 entries even if the series is longer", () => {
    // If earlier entries were considered, this would change the baseline;
    // since they aren't, baseline is still (100+100+100)/3 = 100.
    const result = checkAnomaly(series([9999, 9999, 100, 100, 100, 200]), { absoluteFloor: 0 });
    expect(result.baseline).toBe(100);
    expect(result.isAnomaly).toBe(true);
  });

  it("respects a custom pctThreshold", () => {
    const result = checkAnomaly(series([100, 100, 100, 110]), { absoluteFloor: 0, pctThreshold: 0.05 });
    expect(result.isAnomaly).toBe(true); // 10% over > 5% threshold
  });
});

describe("computeGroupSeries", () => {
  it("sums member series by sign multiplier, period by period", () => {
    const generation = series([100, 200]);
    const consumption = series([30, 40]);
    const net = computeGroupSeries([
      { signMultiplier: 1, series: generation },
      { signMultiplier: -1, series: consumption },
    ]);
    expect(net.map((s) => s.consumption)).toEqual([70, 160]);
  });

  it("propagates null if any member's value is null for that period", () => {
    const a = series([100, null]);
    const b = series([10, 20]);
    const net = computeGroupSeries([
      { signMultiplier: 1, series: a },
      { signMultiplier: 1, series: b },
    ]);
    expect(net.map((s) => s.consumption)).toEqual([110, null]);
  });

  it("returns an empty array for an empty member list", () => {
    expect(computeGroupSeries([])).toEqual([]);
  });

  function series(values: Array<number | null>): PeriodConsumption[] {
    return values.map((v, i) => ({
      periodStart: `p${i}-start`,
      periodEnd: `p${i}-end`,
      consumption: v,
    }));
  }
});
