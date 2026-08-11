// Owned by the "Meters, groups, readings, photo upload, period-derivation,
// overview" feature slice. See the approved plan, Feature Scope #2, and
// docs/period-derivation.md for the algorithm backing the trend chart,
// month-over-year comparison, and per-meter overview in MeterDetail.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  SEEDED_PROPERTY_ID,
  defaultReadingKindForMeterType,
  meterTypeSchema,
  readingIntervalSchema,
  meterGroupMemberRoleSchema,
  type Meter,
  type MeterGroup,
  type MeterType,
  type ReadingInterval,
  type ReadingKind,
  type MeterGroupMemberRole,
} from "@house/shared";
import { db } from "../db/dexie";
import StatusRow from "../components/StatusRow";
import { createMeter, createMeterGroup, addMeterGroupMember } from "../data/meters";

const METER_TYPES = meterTypeSchema.options;
const READING_INTERVALS = readingIntervalSchema.options;
const MEMBER_ROLES = meterGroupMemberRoleSchema.options;

const METER_TYPE_LABELS: Record<MeterType, string> = {
  electricity_in: "Electricity (in)",
  electricity_out: "Electricity (out)",
  water: "Water",
  pressure: "Pressure",
  custom: "Custom",
};

function intervalLabel(interval: ReadingInterval): string {
  return interval[0].toUpperCase() + interval.slice(1);
}

function NewMeterForm({ onCreate }: { onCreate: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<MeterType>("electricity_in");
  const [unit, setUnit] = useState("kWh");
  const [readingInterval, setReadingInterval] = useState<ReadingInterval>("monthly");
  const [readingKind, setReadingKind] = useState<ReadingKind>(
    defaultReadingKindForMeterType("electricity_in")
  );
  const [readingKindTouched, setReadingKindTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleTypeChange(next: MeterType) {
    setType(next);
    if (!readingKindTouched) {
      setReadingKind(defaultReadingKindForMeterType(next));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !unit.trim()) {
      setError("Fill in a name and unit.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await createMeter({
        propertyId: SEEDED_PROPERTY_ID,
        name: name.trim(),
        type,
        unit: unit.trim(),
        readingInterval,
        readingKind,
      });
      setName("");
      setUnit("kWh");
      setReadingKindTouched(false);
      onCreate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create meter.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border bg-surface p-4 mb-6 grid gap-3">
      <div className="label-plate">New meter</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="grid gap-1">
          <span className="label-plate">Name</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Main electricity"
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Type</span>
          <select
            className="border border-border bg-bg px-2 py-1.5"
            value={type}
            onChange={(e) => handleTypeChange(e.target.value as MeterType)}
          >
            {METER_TYPES.map((t) => (
              <option key={t} value={t}>
                {METER_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Unit</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="kWh"
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Reading interval</span>
          <select
            className="border border-border bg-bg px-2 py-1.5"
            value={readingInterval}
            onChange={(e) => setReadingInterval(e.target.value as ReadingInterval)}
          >
            {READING_INTERVALS.map((i) => (
              <option key={i} value={i}>
                {intervalLabel(i)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Reading kind</span>
          <select
            className="border border-border bg-bg px-2 py-1.5"
            value={readingKind}
            onChange={(e) => {
              setReadingKindTouched(true);
              setReadingKind(e.target.value as ReadingKind);
            }}
          >
            <option value="cumulative">Cumulative (running counter)</option>
            <option value="snapshot">Snapshot (point value)</option>
          </select>
        </label>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <button
        type="submit"
        disabled={submitting}
        className="justify-self-start border border-accent-strong bg-accent text-surface px-4 py-1.5 disabled:opacity-50"
      >
        {submitting ? "Adding…" : "Add meter"}
      </button>
    </form>
  );
}

function NewMeterGroupForm({ onCreate }: { onCreate: () => void }) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("kWh");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !unit.trim()) {
      setError("Fill in a name and unit.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await createMeterGroup({ propertyId: SEEDED_PROPERTY_ID, name: name.trim(), unit: unit.trim() });
      setName("");
      setUnit("kWh");
      onCreate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create meter group.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border bg-surface p-4 mb-6 grid gap-3">
      <div className="label-plate">New meter group</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="grid gap-1">
          <span className="label-plate">Name</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Electricity (net)"
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Unit</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="kWh"
          />
        </label>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <button
        type="submit"
        disabled={submitting}
        className="justify-self-start border border-accent-strong bg-accent text-surface px-4 py-1.5 disabled:opacity-50"
      >
        {submitting ? "Adding…" : "Add group"}
      </button>
    </form>
  );
}

interface AddMemberFormProps {
  group: MeterGroup;
  candidateMeters: Meter[];
}

function AddMemberForm({ group, candidateMeters }: AddMemberFormProps) {
  const [meterId, setMeterId] = useState(candidateMeters[0]?.id ?? "");
  const [role, setRole] = useState<MeterGroupMemberRole>("in");
  const [signMultiplier, setSignMultiplier] = useState<1 | -1>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // candidateMeters is derived from live Dexie data and shrinks after a
  // successful add (the just-added meter is no longer a candidate) — keep
  // the selection in sync so a second submit can't silently resubmit a
  // stale (now-already-a-member) meterId. addMeterGroupMember itself also
  // rejects duplicate membership, so this is a UX fix on top of a real
  // data-layer guard, not the only thing preventing corruption.
  useEffect(() => {
    if (!candidateMeters.some((m) => m.id === meterId)) {
      setMeterId(candidateMeters[0]?.id ?? "");
    }
  }, [candidateMeters, meterId]);

  if (candidateMeters.length === 0) {
    return <div className="text-sm text-muted px-4 py-2">No other meters available to add.</div>;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!meterId) return;
    setError(null);
    setSubmitting(true);
    try {
      await addMeterGroupMember({ groupId: group.id, meterId, role, signMultiplier });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add member.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="px-4 py-3 grid gap-2 border-t border-border">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
        <label className="grid gap-1 col-span-2">
          <span className="label-plate">Meter</span>
          <select
            className="border border-border bg-bg px-2 py-1.5"
            value={meterId}
            onChange={(e) => setMeterId(e.target.value)}
          >
            {candidateMeters.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Role</span>
          <select
            className="border border-border bg-bg px-2 py-1.5"
            value={role}
            onChange={(e) => setRole(e.target.value as MeterGroupMemberRole)}
          >
            {MEMBER_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Sign</span>
          <select
            className="border border-border bg-bg px-2 py-1.5"
            value={signMultiplier}
            onChange={(e) => setSignMultiplier(Number(e.target.value) as 1 | -1)}
          >
            <option value={1}>+1 (in)</option>
            <option value={-1}>-1 (out)</option>
          </select>
        </label>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <button
        type="submit"
        disabled={submitting}
        className="justify-self-start border border-border px-3 py-1 text-sm disabled:opacity-50"
      >
        {submitting ? "Adding…" : "Add to group"}
      </button>
    </form>
  );
}

export default function Meters() {
  const [showMeterForm, setShowMeterForm] = useState(false);
  const [showGroupForm, setShowGroupForm] = useState(false);

  const meters = useLiveQuery(
    () =>
      db.meters
        .where("propertyId")
        .equals(SEEDED_PROPERTY_ID)
        .and((m) => m.deletedAt == null)
        .toArray(),
    []
  );
  const groups = useLiveQuery(
    () =>
      db.meterGroups
        .where("propertyId")
        .equals(SEEDED_PROPERTY_ID)
        .and((g) => g.deletedAt == null)
        .toArray(),
    []
  );
  const members = useLiveQuery(() => db.meterGroupMembers.filter((m) => m.deletedAt == null).toArray(), []);

  const sortedMeters = [...(meters ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const sortedGroups = [...(groups ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const meterById = new Map((meters ?? []).map((m) => [m.id, m]));

  return (
    <div className="max-w-3xl mx-auto px-4 pt-8 pb-4 md:pt-12">
      <header className="mb-6">
        <div className="label-plate">House Maintenance</div>
        <h1 className="font-display italic text-3xl md:text-4xl mt-1">Meters</h1>
      </header>

      <div className="tick-rule mb-6" />

      <div className="flex gap-3 mb-6">
        <button
          className="label-plate text-accent hover:text-accent-strong"
          onClick={() => setShowMeterForm((v) => !v)}
        >
          {showMeterForm ? "− Add meter" : "+ Add meter"}
        </button>
        <button
          className="label-plate text-accent hover:text-accent-strong"
          onClick={() => setShowGroupForm((v) => !v)}
        >
          {showGroupForm ? "− Add group" : "+ Add group"}
        </button>
      </div>

      {showMeterForm && <NewMeterForm onCreate={() => setShowMeterForm(false)} />}
      {showGroupForm && <NewMeterGroupForm onCreate={() => setShowGroupForm(false)} />}

      <section aria-label="Meters" className="mb-8">
        <div className="label-plate mb-1">Meters</div>
        {meters === undefined ? (
          <div className="text-muted text-sm">Loading…</div>
        ) : sortedMeters.length === 0 ? (
          <div className="text-muted text-sm">No meters yet — add one above.</div>
        ) : (
          <div className="divide-y divide-border border-t border-b border-border">
            {sortedMeters.map((meter) => (
              <Link key={meter.id} to={`/meters/${meter.id}`} className="block hover:bg-surface">
                <StatusRow
                  title={meter.name}
                  meta={`${METER_TYPE_LABELS[meter.type]} · ${intervalLabel(meter.readingInterval)}`}
                  tone="muted"
                  trailing={meter.unit}
                />
              </Link>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Meter groups">
        <div className="label-plate mb-1">Meter groups</div>
        {groups === undefined ? (
          <div className="text-muted text-sm">Loading…</div>
        ) : sortedGroups.length === 0 ? (
          <div className="text-muted text-sm">No meter groups yet.</div>
        ) : (
          sortedGroups.map((group) => {
            const groupMembers = (members ?? []).filter((m) => m.groupId === group.id);
            const usedMeterIds = new Set(groupMembers.map((m) => m.meterId));
            const candidateMeters = (meters ?? []).filter((m) => !usedMeterIds.has(m.id));
            return (
              <div key={group.id} className="border border-border bg-surface mb-4">
                <div className="p-4 border-b border-border flex items-baseline justify-between gap-3">
                  <Link to={`/meters/${group.id}`} className="font-display text-lg hover:text-accent">
                    {group.name}
                  </Link>
                  <div className="label-plate">{group.unit}</div>
                </div>
                <div className="divide-y divide-border">
                  {groupMembers.length === 0 && (
                    <div className="px-4 py-3 text-sm text-muted">No members yet.</div>
                  )}
                  {groupMembers.map((member) => {
                    const meter = meterById.get(member.meterId);
                    return (
                      <StatusRow
                        key={member.id}
                        title={meter?.name ?? member.meterId}
                        meta={`${member.role} · sign ${member.signMultiplier > 0 ? "+" : ""}${member.signMultiplier}`}
                        tone="muted"
                      />
                    );
                  })}
                </div>
                <AddMemberForm group={group} candidateMeters={candidateMeters} />
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
