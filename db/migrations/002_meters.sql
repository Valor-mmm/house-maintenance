-- Meters, groups and their membership. Syncable tables — `id` is
-- client-generated, `updated_at` is server-assigned on every write
-- (never trust a client-supplied value). See docs/sync-design.md.

create table meters (
  id uuid primary key,
  property_id uuid not null references properties(id) on delete cascade,
  name text not null,
  type text not null check (type in ('electricity_in','electricity_out','water','pressure','custom')),
  unit text not null,
  reading_interval text not null check (reading_interval in ('daily','weekly','monthly','quarterly','yearly')),
  reading_kind text not null check (reading_kind in ('cumulative','snapshot')),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_meters_property on meters(property_id) where deleted_at is null;
create index idx_meters_sync on meters(updated_at, id);

create table meter_groups (
  id uuid primary key,
  property_id uuid not null references properties(id) on delete cascade,
  name text not null,
  unit text not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_meter_groups_property on meter_groups(property_id) where deleted_at is null;
create index idx_meter_groups_sync on meter_groups(updated_at, id);

-- Net value for a group = sum(reading.value * sign_multiplier) across its
-- members. Application layer must validate (at write time) that all
-- members of a group share reading_kind and unit — see
-- docs/period-derivation.md "Meter groups".
create table meter_group_members (
  id uuid primary key,
  group_id uuid not null references meter_groups(id) on delete cascade,
  meter_id uuid not null references meters(id) on delete cascade,
  role text not null check (role in ('in','out','other')),
  sign_multiplier smallint not null check (sign_multiplier in (1,-1)),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (group_id, meter_id)
);
create index idx_meter_group_members_sync on meter_group_members(updated_at, id);

-- Meter reset/replacement events. Delta calculations must never bridge a
-- period across one of these without special-casing it — see
-- docs/period-derivation.md.
create table meter_events (
  id uuid primary key,
  meter_id uuid not null references meters(id) on delete cascade,
  event_type text not null check (event_type in ('reset','replaced')),
  occurred_at timestamptz not null,
  pre_event_final_value double precision not null,
  post_event_start_value double precision not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_meter_events_meter on meter_events(meter_id, occurred_at) where deleted_at is null;
create index idx_meter_events_sync on meter_events(updated_at, id);
