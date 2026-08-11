-- Readings. Syncable. `photo_blob_url` is written ONLY via the dedicated
-- photo-attach endpoint, never via the generic sync push path — see
-- docs/sync-design.md "Photo attach: a dedicated path, not a row field race".
-- `client_edited_at` is audit/UX display only, never used for sync ordering.

create table readings (
  id uuid primary key,
  meter_id uuid not null references meters(id) on delete cascade,
  value double precision not null,
  captured_at timestamptz not null,
  note text,
  photo_blob_url text,
  photo_exif jsonb,
  client_edited_at timestamptz not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Required for the period-boundary "nearest reading before/after" queries
-- in docs/period-derivation.md to perform reasonably.
create index idx_readings_meter_captured on readings(meter_id, captured_at) where deleted_at is null;
create index idx_readings_sync on readings(updated_at, id);
