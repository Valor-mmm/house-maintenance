-- Optional per-meter warning bounds — most useful on snapshot meters
-- (e.g. a heating/water pressure gauge) where the raw value itself
-- should stay in range. Nullable: null means "no bound set", never a
-- sentinel like 0. See packages/shared/src/pressure-trend.ts and
-- docs/period-derivation.md "Pressure thresholds & decline trend".
-- Synced like any other meter column (packages/server-lib/src/sync-tables.ts).

alter table meters
  add column min_threshold double precision,
  add column max_threshold double precision;
