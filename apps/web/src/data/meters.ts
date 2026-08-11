import {
  type Meter,
  type MeterCreateInput,
  type MeterGroup,
  type MeterGroupCreateInput,
  type MeterGroupMember,
  type MeterGroupMemberCreateInput,
  type MeterEvent,
  type MeterEventCreateInput,
} from "@house/shared";
import { db } from "../db/dexie";
import { enqueueForSync } from "../sync/engine";

/**
 * Local write helpers for meters / meter groups / meter group members /
 * meter events (see docs/sync-design.md and packages/shared/src/meter.ts).
 * Every helper writes to Dexie with a client-generated UUID and then
 * calls `enqueueForSync` — push/pull happens automatically in the
 * background from there.
 *
 * `updatedAt` is server-assigned, always (see docs/sync-design.md). New
 * rows get the sentinel below rather than a client clock reading, so a
 * locally-created row can never masquerade as a genuine server
 * timestamp; the server ignores whatever `updatedAt` the client sends on
 * push and always assigns its own via `now()`, so this placeholder is
 * only ever visible on this device until the next push/pull round-trip
 * overwrites it with the real value. Mirrors the convention in
 * ../data/tasks.ts.
 */
const UNSYNCED_UPDATED_AT = new Date(0).toISOString();

export type CreateMeterInput = Omit<MeterCreateInput, "id">;

/**
 * Shared by createMeter/editMeter: a meter's minThreshold, if both bounds
 * are set, must be strictly less than its maxThreshold — otherwise
 * "approaching_min"/"approaching_max" in computePressureTrend
 * (pressure-trend.ts) can never both be meaningful. Not enforced in the
 * zod schema (meter.ts) so that schema stays a plain object other
 * schemas can merge/extend.
 */
function validateThresholds(minThreshold: number | null, maxThreshold: number | null): void {
  if (minThreshold != null && maxThreshold != null && minThreshold >= maxThreshold) {
    throw new Error("Minimum threshold must be less than maximum threshold.");
  }
}

export async function createMeter(input: CreateMeterInput): Promise<Meter> {
  validateThresholds(input.minThreshold, input.maxThreshold);
  const id = crypto.randomUUID();
  const meter: Meter = {
    id,
    ...input,
    updatedAt: UNSYNCED_UPDATED_AT,
    deletedAt: null,
  };
  await db.transaction("rw", db.meters, db.outbox, async () => {
    await db.meters.add(meter);
    await enqueueForSync("meters", id);
  });
  return meter;
}

export interface EditMeterInput {
  name?: string;
  type?: Meter["type"];
  unit?: string;
  readingInterval?: Meter["readingInterval"];
  readingKind?: Meter["readingKind"];
  minThreshold?: number | null;
  maxThreshold?: number | null;
}

/**
 * `unit` and `readingKind` are load-bearing for math that's derived fresh
 * from current meter state every time it's read (see
 * packages/period-derivation.ts): readingKind controls whether a meter's
 * *entire* reading history is interpreted as a running counter (delta
 * between readings) or point-in-time snapshots, and unit is what
 * addMeterGroupMember validated against every other member's unit when
 * this meter joined a group. Changing either after the fact would
 * silently reinterpret old readings or desync a group's net calculation
 * with no error and no visible warning — so both are blocked once
 * there's something that depends on the current value: readingKind once
 * the meter has any readings, unit while the meter is a live group
 * member.
 */
export async function editMeter(id: string, patch: EditMeterInput): Promise<Meter> {
  const existing = await db.meters.get(id);
  if (!existing || existing.deletedAt) {
    throw new Error("Meter not found.");
  }
  if (
    (patch.readingKind !== undefined && patch.readingKind !== existing.readingKind) ||
    (patch.unit !== undefined && patch.unit !== existing.unit)
  ) {
    const liveMemberships = await db.meterGroupMembers
      .where("meterId")
      .equals(id)
      .filter((m) => m.deletedAt == null)
      .toArray();
    if (liveMemberships.length > 0) {
      throw new Error(
        `Can't change unit or reading kind while "${existing.name}" is a member of a meter group — remove it from the group first.`
      );
    }
  }
  if (patch.readingKind !== undefined && patch.readingKind !== existing.readingKind) {
    const readingCount = await db.readings
      .where("meterId")
      .equals(id)
      .filter((r) => r.deletedAt == null)
      .count();
    if (readingCount > 0) {
      throw new Error(
        `Can't change reading kind: "${existing.name}" has ${readingCount} existing reading(s) that depend on it. Delete them first if you really need to change this.`
      );
    }
  }
  const minThreshold = patch.minThreshold !== undefined ? patch.minThreshold : existing.minThreshold;
  const maxThreshold = patch.maxThreshold !== undefined ? patch.maxThreshold : existing.maxThreshold;
  validateThresholds(minThreshold, maxThreshold);
  const updated: Meter = {
    ...existing,
    name: patch.name ?? existing.name,
    type: patch.type ?? existing.type,
    unit: patch.unit ?? existing.unit,
    readingInterval: patch.readingInterval ?? existing.readingInterval,
    readingKind: patch.readingKind ?? existing.readingKind,
    minThreshold,
    maxThreshold,
  };
  await db.transaction("rw", db.meters, db.outbox, async () => {
    await db.meters.put(updated);
    await enqueueForSync("meters", id);
  });
  return updated;
}

/**
 * Soft-deletes a meter and, since a deleted meter can no longer be a
 * meaningful group member (see docs/period-derivation.md "Meter groups"),
 * cascades to soft-delete any of its memberships too — otherwise
 * GroupDetailView would keep netting in a value for a meter that no
 * longer exists.
 */
export async function deleteMeter(id: string): Promise<void> {
  const existing = await db.meters.get(id);
  if (!existing || existing.deletedAt) return;
  const now = new Date().toISOString();
  const memberships = await db.meterGroupMembers
    .where("meterId")
    .equals(id)
    .filter((m) => m.deletedAt == null)
    .toArray();
  await db.transaction("rw", db.meters, db.meterGroupMembers, db.outbox, async () => {
    await db.meters.put({ ...existing, deletedAt: now });
    await enqueueForSync("meters", id);
    for (const m of memberships) {
      await db.meterGroupMembers.put({ ...m, deletedAt: now });
      await enqueueForSync("meterGroupMembers", m.id);
    }
  });
}

export type CreateMeterGroupInput = Omit<MeterGroupCreateInput, "id">;

export async function createMeterGroup(input: CreateMeterGroupInput): Promise<MeterGroup> {
  const id = crypto.randomUUID();
  const group: MeterGroup = {
    id,
    ...input,
    updatedAt: UNSYNCED_UPDATED_AT,
    deletedAt: null,
  };
  await db.transaction("rw", db.meterGroups, db.outbox, async () => {
    await db.meterGroups.add(group);
    await enqueueForSync("meterGroups", id);
  });
  return group;
}

export interface EditMeterGroupInput {
  name?: string;
  unit?: string;
}

export async function editMeterGroup(id: string, patch: EditMeterGroupInput): Promise<MeterGroup> {
  const existing = await db.meterGroups.get(id);
  if (!existing || existing.deletedAt) {
    throw new Error("Meter group not found.");
  }
  if (patch.unit !== undefined && patch.unit !== existing.unit) {
    const liveMemberCount = await db.meterGroupMembers
      .where("groupId")
      .equals(id)
      .filter((m) => m.deletedAt == null)
      .count();
    if (liveMemberCount > 0) {
      throw new Error(
        `Can't change "${existing.name}"'s unit while it has members — every member was validated against the group's current unit when it was added. Remove its members first.`
      );
    }
  }
  const updated: MeterGroup = {
    ...existing,
    name: patch.name ?? existing.name,
    unit: patch.unit ?? existing.unit,
  };
  await db.transaction("rw", db.meterGroups, db.outbox, async () => {
    await db.meterGroups.put(updated);
    await enqueueForSync("meterGroups", id);
  });
  return updated;
}

export async function deleteMeterGroup(id: string): Promise<void> {
  const existing = await db.meterGroups.get(id);
  if (!existing || existing.deletedAt) return;
  const now = new Date().toISOString();
  const memberships = await db.meterGroupMembers
    .where("groupId")
    .equals(id)
    .filter((m) => m.deletedAt == null)
    .toArray();
  await db.transaction("rw", db.meterGroups, db.meterGroupMembers, db.outbox, async () => {
    await db.meterGroups.put({ ...existing, deletedAt: now });
    await enqueueForSync("meterGroups", id);
    for (const m of memberships) {
      await db.meterGroupMembers.put({ ...m, deletedAt: now });
      await enqueueForSync("meterGroupMembers", m.id);
    }
  });
}

export async function removeMeterGroupMember(id: string): Promise<void> {
  const existing = await db.meterGroupMembers.get(id);
  if (!existing || existing.deletedAt) return;
  const now = new Date().toISOString();
  await db.transaction("rw", db.meterGroupMembers, db.outbox, async () => {
    await db.meterGroupMembers.put({ ...existing, deletedAt: now });
    await enqueueForSync("meterGroupMembers", id);
  });
}

export type AddMeterGroupMemberInput = Omit<MeterGroupMemberCreateInput, "id">;

/**
 * Adds a meter to a group. Per docs/period-derivation.md "Meter groups",
 * a group nets its members' period consumption together, so every member
 * must share the same unit as the group and the same readingKind as any
 * other current member — otherwise the net value is meaningless (you
 * can't sum kWh and gallons, or a running counter delta with a snapshot
 * that has no delta concept). Rejects with a plain Error, which callers
 * should catch and surface in the UI, rather than silently coercing.
 */
export async function addMeterGroupMember(input: AddMeterGroupMemberInput): Promise<MeterGroupMember> {
  const group = await db.meterGroups.get(input.groupId);
  if (!group || group.deletedAt) {
    throw new Error("Meter group not found.");
  }
  const meter = await db.meters.get(input.meterId);
  if (!meter || meter.deletedAt) {
    throw new Error("Meter not found.");
  }
  if (meter.unit !== group.unit) {
    throw new Error(
      `"${meter.name}" uses unit "${meter.unit}", but the group "${group.name}" uses "${group.unit}" — units must match.`
    );
  }

  const existingMembers = await db.meterGroupMembers
    .where("groupId")
    .equals(input.groupId)
    .filter((m) => m.deletedAt == null)
    .toArray();
  // Without this, re-submitting the add-member form with a stale
  // selection (e.g. after a successful add, before the UI resets the
  // dropdown) silently double-counts that meter in the group's net
  // consumption — see docs/period-derivation.md "Meter groups", which
  // assumes distinct members.
  if (existingMembers.some((m) => m.meterId === input.meterId)) {
    throw new Error(`"${meter.name}" is already a member of "${group.name}".`);
  }
  if (existingMembers.length > 0) {
    const memberMeters = await db.meters.bulkGet(existingMembers.map((m) => m.meterId));
    const mismatch = memberMeters.find(
      (m): m is Meter => m != null && m.readingKind !== meter.readingKind
    );
    if (mismatch) {
      throw new Error(
        `"${meter.name}" is ${meter.readingKind}, but "${mismatch.name}" already in this group is ${mismatch.readingKind} — all members of a group must share the same reading kind.`
      );
    }
  }

  const id = crypto.randomUUID();
  const member: MeterGroupMember = {
    id,
    ...input,
    updatedAt: UNSYNCED_UPDATED_AT,
    deletedAt: null,
  };
  await db.transaction("rw", db.meterGroupMembers, db.outbox, async () => {
    await db.meterGroupMembers.add(member);
    await enqueueForSync("meterGroupMembers", id);
  });
  return member;
}

export type CreateMeterEventInput = Omit<MeterEventCreateInput, "id">;

export async function createMeterEvent(input: CreateMeterEventInput): Promise<MeterEvent> {
  const id = crypto.randomUUID();
  const event: MeterEvent = {
    id,
    ...input,
    updatedAt: UNSYNCED_UPDATED_AT,
    deletedAt: null,
  };
  await db.transaction("rw", db.meterEvents, db.outbox, async () => {
    await db.meterEvents.add(event);
    await enqueueForSync("meterEvents", id);
  });
  return event;
}
