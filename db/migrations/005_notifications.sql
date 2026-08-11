-- Server-computed/managed, not offline-synced (see docs/sync-design.md).

create table anomaly_flags (
  id uuid primary key default gen_random_uuid(),
  meter_id uuid references meters(id) on delete cascade,
  meter_group_id uuid references meter_groups(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  computed_value double precision not null,
  baseline_value double precision not null,
  pct_over double precision not null,
  -- null until the daily cron pushes a notification for this flag; the
  -- cron only pushes once per flag (see docs/period-derivation.md "Step 4").
  notified_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  constraint chk_anomaly_exactly_one_target check ((meter_id is null) <> (meter_group_id is null))
);

-- Two partial unique indexes rather than one plain unique constraint:
-- Postgres treats NULLs as distinct in a unique constraint, so a single
-- constraint across (meter_id, meter_group_id, period_start, period_end)
-- would NOT actually dedupe rows where meter_id is always null (the
-- meter_group case) or vice versa.
create unique index uq_anomaly_meter on anomaly_flags(meter_id, period_start, period_end) where meter_id is not null;
create unique index uq_anomaly_group on anomaly_flags(meter_group_id, period_start, period_end) where meter_group_id is not null;

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  keys_json jsonb not null,
  created_at timestamptz not null default now()
);
