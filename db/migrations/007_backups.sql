-- Backup archive metadata. Server-authoritative, not offline-synced (same
-- category as anomaly_flags/push_subscriptions in 005_notifications.sql —
-- see docs/sync-design.md). The archive bytes themselves live in Vercel
-- Blob under backups/*.zip; this row is what the UI lists and what the
-- cron's retention sweep prunes.

create table backups (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('automated', 'manual')),
  status text not null check (status in ('running', 'complete', 'failed')) default 'running',
  blob_url text,
  blob_pathname text,
  size_bytes bigint,
  table_counts jsonb,
  photo_count integer,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index idx_backups_created on backups(created_at desc);
