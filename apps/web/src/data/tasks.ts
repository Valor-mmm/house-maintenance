import {
  SEEDED_PROPERTY_ID,
  type RecurrenceRule,
  type TaskTemplate,
  type TaskInstance,
} from "@house/shared";
import { db } from "../db/dexie";
import { enqueueForSync } from "../sync/engine";

/**
 * Local write helpers for task templates / instances (see
 * docs/sync-design.md and packages/shared/src/task.ts). Every helper here
 * writes to Dexie with a client-generated UUID and then calls
 * `enqueueForSync` — that's the entire sync integration a feature slice
 * needs; push/pull happens automatically in the background.
 *
 * `updatedAt` is server-assigned, always (see docs/sync-design.md) — this
 * file never writes a real timestamp into it. New rows get the sentinel
 * below instead of a client clock reading, so they can never masquerade
 * as a genuine server timestamp; edits to existing rows leave whatever
 * `updatedAt` the row already had untouched. Either way the value is
 * purely a local placeholder: the server ignores whatever `updatedAt` the
 * client sends on push and always assigns its own via `now()` (see
 * `upsertSyncRow` in packages/server-lib/src/sync-tables.ts), so this
 * placeholder is only ever visible to this device until the next
 * successful push/pull round-trip overwrites it with the real value.
 */
const UNSYNCED_UPDATED_AT = new Date(0).toISOString();

function toIsoDateTime(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

/** everyN/unit -> a new Date offset from `from`, per the template's recurrence rule. */
function addRecurrence(from: Date, rule: RecurrenceRule): Date {
  const result = new Date(from);
  switch (rule.unit) {
    case "days":
      result.setUTCDate(result.getUTCDate() + rule.everyN);
      break;
    case "weeks":
      result.setUTCDate(result.getUTCDate() + rule.everyN * 7);
      break;
    case "months":
      // Note: month-length overflow (e.g. Jan 31 + 1 month) follows JS
      // Date's own rollover behavior (lands in March, not clamped to Feb
      // 28/29). Accepted as a v1 edge case — see report for discussion.
      result.setUTCMonth(result.getUTCMonth() + rule.everyN);
      break;
    case "years":
      result.setUTCFullYear(result.getUTCFullYear() + rule.everyN);
      break;
  }
  return result;
}

export interface CreateTaskTemplateInput {
  name: string;
  category: string;
  recurrenceRule: RecurrenceRule;
  /** Due date for the first generated instance. Defaults to now. */
  firstDueDate?: Date | string;
}

/** Creates a task template AND its first due instance (see plan: "on template creation, create an initial instance"). */
export async function createTaskTemplate(input: CreateTaskTemplateInput): Promise<{
  template: TaskTemplate;
  instance: TaskInstance;
}> {
  const id = crypto.randomUUID();
  const template: TaskTemplate = {
    id,
    propertyId: SEEDED_PROPERTY_ID,
    name: input.name,
    category: input.category,
    recurrenceRule: input.recurrenceRule,
    updatedAt: UNSYNCED_UPDATED_AT,
    deletedAt: null,
  };

  await db.transaction("rw", db.taskTemplates, db.outbox, async () => {
    await db.taskTemplates.add(template);
    await enqueueForSync("taskTemplates", id);
  });

  const instance = await createTaskInstance({
    templateId: id,
    dueDate: input.firstDueDate ?? new Date(),
  });

  return { template, instance };
}

export interface EditTaskTemplateInput {
  name?: string;
  category?: string;
  recurrenceRule?: RecurrenceRule;
}

export async function editTaskTemplate(id: string, patch: EditTaskTemplateInput): Promise<TaskTemplate> {
  const existing = await db.taskTemplates.get(id);
  if (!existing || existing.deletedAt) {
    throw new Error("Task template not found.");
  }
  const updated: TaskTemplate = {
    ...existing,
    name: patch.name ?? existing.name,
    category: patch.category ?? existing.category,
    recurrenceRule: patch.recurrenceRule ?? existing.recurrenceRule,
  };
  await db.transaction("rw", db.taskTemplates, db.outbox, async () => {
    await db.taskTemplates.put(updated);
    await enqueueForSync("taskTemplates", id);
  });
  return updated;
}

/**
 * Soft-deletes a template and cascades to its still-pending (not yet
 * completed) instances — they'd otherwise keep showing up as due with no
 * template left to recur from. Completed instances are left alone; they're
 * history (cost/note records), not live obligations.
 */
export async function deleteTaskTemplate(id: string): Promise<void> {
  const existing = await db.taskTemplates.get(id);
  if (!existing || existing.deletedAt) return;
  const now = new Date().toISOString();
  const pending = await db.taskInstances
    .where("templateId")
    .equals(id)
    .filter((i) => i.deletedAt == null && i.completedAt == null)
    .toArray();
  await db.transaction("rw", db.taskTemplates, db.taskInstances, db.outbox, async () => {
    await db.taskTemplates.put({ ...existing, deletedAt: now });
    await enqueueForSync("taskTemplates", id);
    for (const instance of pending) {
      await db.taskInstances.put({ ...instance, deletedAt: now });
      await enqueueForSync("taskInstances", instance.id);
    }
  });
}

export async function deleteTaskInstance(id: string): Promise<void> {
  const existing = await db.taskInstances.get(id);
  if (!existing || existing.deletedAt) return;
  const updated: TaskInstance = { ...existing, deletedAt: new Date().toISOString() };
  await db.transaction("rw", db.taskInstances, db.outbox, async () => {
    await db.taskInstances.put(updated);
    await enqueueForSync("taskInstances", id);
  });
}

export interface CreateTaskInstanceInput {
  templateId: string;
  dueDate: Date | string;
}

export async function createTaskInstance(input: CreateTaskInstanceInput): Promise<TaskInstance> {
  const id = crypto.randomUUID();
  const instance: TaskInstance = {
    id,
    templateId: input.templateId,
    dueDate: toIsoDateTime(input.dueDate),
    completedAt: null,
    completedNote: null,
    cost: null,
    lastNotifiedAt: null,
    updatedAt: UNSYNCED_UPDATED_AT,
    deletedAt: null,
  };

  await db.transaction("rw", db.taskInstances, db.outbox, async () => {
    await db.taskInstances.add(instance);
    await enqueueForSync("taskInstances", id);
  });

  return instance;
}

export interface CompleteTaskInstanceInput {
  completedNote?: string | null;
  cost?: number | null;
}

/**
 * Marks an instance complete (captures `completedAt = now`, plus optional
 * note/cost) and, if its template still exists and isn't deleted,
 * generates the next due instance per the template's recurrence rule —
 * `nextDueDate = thisInstance.dueDate + everyN * unit`. Deliberately
 * offset from the instance's own due date rather than from "today", so a
 * task completed late doesn't shift its whole future schedule forward.
 */
export async function completeTaskInstance(
  instanceId: string,
  input: CompleteTaskInstanceInput = {}
): Promise<{ completed: TaskInstance; next: TaskInstance | null }> {
  const existing = await db.taskInstances.get(instanceId);
  if (!existing || existing.deletedAt) {
    throw new Error(`completeTaskInstance: no task instance with id ${instanceId}`);
  }
  // Idempotency guard: without this, calling completeTaskInstance twice
  // for the same instance (a re-entrant call, a retry, a future second
  // caller) would generate two duplicate "next" instances below, since
  // nothing else in this function is safe to call more than once.
  if (existing.completedAt != null) {
    return { completed: existing, next: null };
  }

  const completed: TaskInstance = {
    ...existing,
    completedAt: new Date().toISOString(),
    completedNote: input.completedNote ?? null,
    cost: input.cost ?? null,
  };

  await db.transaction("rw", db.taskInstances, db.outbox, async () => {
    await db.taskInstances.put(completed);
    await enqueueForSync("taskInstances", instanceId);
  });

  const template = await db.taskTemplates.get(existing.templateId);
  let next: TaskInstance | null = null;
  if (template && !template.deletedAt) {
    const nextDueDate = addRecurrence(new Date(existing.dueDate), template.recurrenceRule);
    next = await createTaskInstance({ templateId: existing.templateId, dueDate: nextDueDate });
  }

  return { completed, next };
}
