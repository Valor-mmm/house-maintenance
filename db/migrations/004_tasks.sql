-- Maintenance tasks. Syncable. `cost` assumes a single currency for v1
-- (stated explicitly rather than silently implied).

create table task_templates (
  id uuid primary key,
  property_id uuid not null references properties(id) on delete cascade,
  name text not null,
  category text not null,
  recurrence_rule jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_task_templates_property on task_templates(property_id) where deleted_at is null;
create index idx_task_templates_sync on task_templates(updated_at, id);

create table task_instances (
  id uuid primary key,
  template_id uuid not null references task_templates(id) on delete cascade,
  due_date timestamptz not null,
  completed_at timestamptz,
  completed_note text,
  cost numeric(12,2),
  -- so the daily cron doesn't re-push the same overdue task every day
  last_notified_at timestamptz,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_task_instances_template on task_instances(template_id) where deleted_at is null;
create index idx_task_instances_due on task_instances(due_date) where completed_at is null and deleted_at is null;
create index idx_task_instances_sync on task_instances(updated_at, id);
