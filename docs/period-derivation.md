# Period derivation

Single source of truth for turning irregularly-spaced cumulative meter
readings into calendar-period (monthly) consumption values. This feeds
**three** features — month-over-year comparison, the per-meter overview
(stats + month-to-month chart), and anomaly detection — and must be
implemented **once**, in `packages/shared` (or a small server-side lib
imported by both the API and any client-side preview rendering), not
reimplemented separately for each feature.

## Inputs

- A meter's `readingKind`: `cumulative` (electricity, water — a running
  counter, like an odometer) or `snapshot` (pressure gauges — a point
  value with no running total). **This algorithm only applies to
  `cumulative` meters.** Snapshot meters are charted as raw values over
  time with no delta/consumption concept.
- The ordered list of a meter's non-deleted `readings` (`capturedAt`,
  `value`).
- The meter's `meterEvents` (reset/replacement), each with `occurredAt`,
  `preEventFinalValue`, `postEventStartValue`.

## Step 1 — derive the cumulative value at a boundary instant `T`

1. Find `r_before` = the latest reading with `capturedAt <= T`.
2. Find `r_after` = the earliest reading with `capturedAt > T`.
3. Find whether any `meterEvent.occurredAt` falls strictly between
   `r_before.capturedAt` and `r_after.capturedAt` (if both exist).
4. Resolve:
   - **If a meter event falls between them**: do not interpolate across
     it. Instead, resolve `T` using only the segment it falls in — e.g.
     if `T` is before the event, treat `r_after` as the event's
     `preEventFinalValue` at `occurredAt` instead of the reading after
     the event; if `T` is after the event, treat `r_before` as the
     event's `postEventStartValue` at `occurredAt` instead of the
     reading before it. Then re-apply steps 4a/4b below within that
     segment.
   - **(4a) Both `r_before` and `r_after` exist, no intervening event, gap
     ≤ `maxInterpolationGap`** (default **45 days**, configurable):
     linearly interpolate —
     ```
     v(T) = r_before.value +
       (r_after.value - r_before.value) *
       (T - r_before.capturedAt) / (r_after.capturedAt - r_before.capturedAt)
     ```
   - **(4b) Only `r_before` exists (or the gap to `r_after` exceeds
     `maxInterpolationGap`), and `r_before` is within `nearTolerance`**
     (default **3 days**) of `T`: use `r_before.value` directly, no
     interpolation.
   - **(4c) Otherwise**: `v(T)` is **undefined**. Callers must treat this
     as "no data," never fall back to a stale reading or coerce to a
     number.

## Step 2 — period consumption

For a calendar month `[monthStart, monthEnd)`:

```
consumption(month) = v(monthEnd) - v(monthStart)
```

If **either** boundary is undefined (Step 1, case 4c), the month's
consumption is `null` — not `0`, not omitted, not silently interpolated
from whatever's nearby. `null` must be visibly represented in charts
("no data this month") and excluded from stats (Step 3) and the anomaly
baseline (Step 4), not treated as zero consumption.

Type: `PeriodConsumption` in `packages/shared/src/period.ts`.

## Step 3 — per-meter overview stats

Over a user-selected date range, compute `average`, `median`, `min`, `max`
across the **non-null** monthly `consumption` values in that range (never
over raw cumulative reading values — those only trend upward and carry no
meaningful average/outlier). `sampleCount` is the number of non-null
months used. If `sampleCount === 0`, all stats are `null`.

Type: `PeriodStats` in `packages/shared/src/period.ts`.

## Step 4 — anomaly detection

For a meter (or meter group, using the group's net value — see below)
and its latest complete period:

1. Compute the latest period's `consumption` (Step 2).
2. Compute the trailing 3 periods before it, same derivation.
3. Require **at least 2 of those 3** to be non-null; otherwise skip the
   check entirely for this period (not enough signal).
4. `baseline = average(non-null trailing periods)`.
5. Flag an anomaly only if **both**:
   - `consumption > baseline * (1 + pctThreshold)` (default
     `pctThreshold = 0.25`), **and**
   - `baseline > absoluteFloor` (a per-meter-type configurable minimum —
     prevents a near-zero baseline, e.g. winter solar export near 0, from
     making a 25% threshold meaningless or hair-trigger on noise).
6. On flag, upsert into `anomalyFlags` (server-authoritative table, not
   synced — see `docs/sync-design.md`) keyed by `(meterId or
   meterGroupId, periodStart, periodEnd)`. Only send a push notification
   if `notifiedAt` is currently null for that flag — this is what stops
   the daily cron from re-pushing the same unresolved anomaly every day.

## Meter groups (net values)

For a `meterGroup` (e.g. "Electricity" = `electricity_in` role `in`
sign `+1`, `electricity_out` role `out` sign `-1`): compute each member
meter's period consumption **independently** via Steps 1–2, then combine:

```
group_consumption(period) = sum(member.consumption * member.signMultiplier)
```

If **any** member's consumption for that period is `null`, the group's
consumption for that period is also `null` — do not silently treat a
missing member as zero. (Never subtract raw reading values directly
between meters; each meter's own delta must be derived independently
first, because they may have different reading cadences.)

## Pressure thresholds & decline trend

A meter may optionally carry `minThreshold`/`maxThreshold` (`meter.ts`,
nullable, no default) — most useful on `snapshot` meters like a
heating/water pressure gauge, where the raw value itself, not a derived
consumption, is what should stay in range. This is a **separate**
algorithm from Steps 1–4 above: it operates on raw reading values
directly (never derived consumption), and unlike anomaly detection it is
**not** restricted to `cumulative` meters — it applies to any meter with
thresholds set, though in practice that's expected to mean `snapshot`
(pressure) meters. Implemented once in
`packages/shared/src/pressure-trend.ts`, client-side only for v1 (no
server cron / push involvement — see below).

1. Take the meter's non-deleted readings, sorted by `capturedAt`.
2. If there are no readings: `status = "no_data"`.
3. If neither threshold is set: `status = "no_thresholds"` (still
   reports `latestValue`/`slopePerDay` if computable, for display).
4. If the latest reading is already at or past a set bound
   (`value <= minThreshold` or `value >= maxThreshold`): `status =
   "below_min"` / `"above_max"` — already crossed, trend is irrelevant.
5. Otherwise, fit a least-squares line (value vs. days elapsed) over the
   last `trendWindowSize` readings (default **10**), requiring at least
   `minPointsForTrend` (default **3**) points in that window; fewer than
   that yields `slopePerDay = null` (not enough signal to predict).
6. If a slope exists and points toward a set bound (negative slope
   toward `minThreshold`, positive toward `maxThreshold`), project when
   `value` reaches that bound:
   `daysUntilCrossing = (threshold - latestValue) / slopePerDay`.
   Only surface it (`status = "approaching_min"` / `"approaching_max"`)
   if that's positive and within `warnWithinDays` (default **30**) — a
   near-zero slope projecting a crossing centuries out is not a
   meaningful warning.
7. Otherwise `status = "ok"`.

**Not synced to the server / not in the daily cron**: unlike anomaly
detection, this is computed client-side from whatever readings are
already in Dexie (Dashboard and MeterDetail both already load the full
reading history) — a deliberate v1 scope cut, no push notification for
pressure warnings yet. `minThreshold`/`maxThreshold` themselves *are*
synced (they're plain meter columns), so the bounds are consistent
across devices even though the warning computation isn't server-side.

## Worked example (for implementer tests)

Water meter, `maxInterpolationGap = 45d`, `nearTolerance = 3d`:

| capturedAt | value |
|---|---|
| 2025-01-05 | 1000 |
| 2025-02-02 | 1040 |
| 2025-02-28 | 1078 |
| 2025-04-20 | 1150 |

- `v(2025-02-01T00:00Z)`: `r_before` = Jan 5 (1000), `r_after` = Feb 2
  (1040), gap 28d ≤ 45d → interpolate: `1000 + 40 * (27/28) ≈ 1038.6`.
- `v(2025-03-01T00:00Z)`: `r_before` = Feb 28 (1078), `r_after` = Apr 20
  (1150), gap 51d > 45d → fall back to 4b: `r_before` (Feb 28) is 1 day
  from the boundary, within 3d tolerance → use `1078` directly.
- February consumption = `v(Mar 1) - v(Feb 1) = 1078 - 1038.6 ≈ 39.4`.
- `v(2025-04-01T00:00Z)`: `r_before` = Feb 28 (1078, 32 days away — not
  within 3d), `r_after` = Apr 20 (1150, 19 days away). Neither 4a's gap
  test (Feb 28 → Apr 20 is 51d > 45d, so no interpolation pair) nor 4b's
  tolerance is satisfied by `r_before` alone → **undefined**. March
  consumption is `null` (needs `v(Apr 1)` which is undefined), not
  computed from the nearest reading.
