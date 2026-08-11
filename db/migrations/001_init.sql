-- Core identity/access tables. Server-authoritative — not offline-synced.
-- See docs/sync-design.md.

create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table properties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('primary_residence', 'rental')),
  created_at timestamptz not null default now()
);

-- The actual extension point for a future second property and/or
-- household sharing: a new row here, not a schema change.
create table property_members (
  user_id uuid not null references users(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  primary key (user_id, property_id)
);
