// Owned by the "Meters, groups, readings, photo upload, period-derivation,
// overview" feature slice: trend chart, month-over-year comparison, and
// the per-meter overview (avg/median/min/max + month-to-month bar chart)
// for a single meter or meter group. See the approved plan, Feature
// Scope #2, and docs/period-derivation.md.
import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import {
  computeMonthlySeries,
  computePeriodStats,
  computeGroupSeries,
  computePressureTrend,
  meterEventTypeSchema,
  meterTypeSchema,
  readingIntervalSchema,
  readingKindSchema,
  type Meter,
  type MeterGroup,
  type MeterGroupMember,
  type MeterEvent,
  type MeterEventType,
  type MeterType,
  type ReadingInterval,
  type ReadingKind,
  type Reading,
  type PeriodConsumption,
} from "@house/shared";
import { db } from "../db/dexie";
import GaugeTile from "../components/GaugeTile";
import StatusRow from "../components/StatusRow";
import { createReading, editReading, deleteReading } from "../data/readings";
import {
  createMeterEvent,
  editMeter,
  deleteMeter,
  editMeterGroup,
  deleteMeterGroup,
  removeMeterGroupMember,
} from "../data/meters";
import { extractExif, storeLocalPhoto, uploadPendingPhoto } from "../data/photos";

const METER_TYPES = meterTypeSchema.options;
const READING_INTERVALS = readingIntervalSchema.options;
const READING_KINDS = readingKindSchema.options;
const METER_TYPE_LABELS: Record<MeterType, string> = {
  electricity_in: "Electricity (in)",
  electricity_out: "Electricity (out)",
  water: "Water",
  pressure: "Pressure",
  custom: "Custom",
};

const YEAR_LINE_COLORS = [
  "var(--color-accent)",
  "var(--color-good)",
  "var(--color-warn)",
  "var(--color-danger)",
];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EVENT_TYPES = meterEventTypeSchema.options;

function fmt(n: number | null | undefined, digits = 1): string {
  return n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function monthShortLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function nowDatetimeLocal(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function datetimeLocalToIso(value: string): string {
  return new Date(value).toISOString();
}

/** "YYYY-MM" month-input default, `monthsAgo` months before the current month, in UTC. */
function monthInputDefault(monthsAgo: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthInputToIsoStart(value: string): string {
  const [y, m] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toISOString();
}

/** Exclusive end boundary: first instant of the month AFTER `value`. */
function monthInputToIsoEndExclusive(value: string): string {
  const [y, m] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString();
}

function yearsPresent(readingsLists: { capturedAt: string }[][], maxYears = 3): number[] {
  const years = new Set<number>();
  for (const list of readingsLists) {
    for (const r of list) years.add(new Date(r.capturedAt).getUTCFullYear());
  }
  return [...years].sort((a, b) => b - a).slice(0, maxYears).sort((a, b) => a - b);
}

interface DateRangeState {
  fromMonth: string;
  toMonth: string;
}

function useDateRange(): [DateRangeState, (r: DateRangeState) => void] {
  const [range, setRange] = useState<DateRangeState>({
    fromMonth: monthInputDefault(11),
    toMonth: monthInputDefault(0),
  });
  return [range, setRange];
}

function DateRangePicker({ range, onChange }: { range: DateRangeState; onChange: (r: DateRangeState) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-3 mb-4">
      <label className="grid gap-1">
        <span className="label-plate">From</span>
        <input
          type="month"
          className="border border-border bg-bg px-2 py-1.5"
          value={range.fromMonth}
          onChange={(e) => onChange({ ...range, fromMonth: e.target.value })}
        />
      </label>
      <label className="grid gap-1">
        <span className="label-plate">To</span>
        <input
          type="month"
          className="border border-border bg-bg px-2 py-1.5"
          value={range.toMonth}
          onChange={(e) => onChange({ ...range, toMonth: e.target.value })}
        />
      </label>
    </div>
  );
}

function OverviewStats({ series, unit }: { series: PeriodConsumption[]; unit: string }) {
  const stats = computePeriodStats(series);
  if (stats.sampleCount === 0) {
    return <div className="text-muted text-sm mb-6">No data in the selected range.</div>;
  }
  const dialMax = Math.max(stats.max ?? 0, Math.abs(stats.min ?? 0), 1);
  const round = (n: number | null) => (n == null ? 0 : Math.round(n * 10) / 10);
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      <GaugeTile label="Average" value={round(stats.average)} max={round(dialMax)} unit={unit} tone="accent" />
      <GaugeTile label="Median" value={round(stats.median)} max={round(dialMax)} unit={unit} tone="accent" />
      <GaugeTile label="Min" value={round(stats.min)} max={round(dialMax)} unit={unit} tone="good" />
      <GaugeTile label="Max" value={round(stats.max)} max={round(dialMax)} unit={unit} tone="warn" />
    </div>
  );
}

function MonthlyBarChart({ series, unit }: { series: PeriodConsumption[]; unit: string }) {
  const data = series.map((s) => ({
    month: monthShortLabel(s.periodStart),
    consumption: s.consumption,
  }));
  return (
    <div className="border border-border bg-surface p-4 mb-6">
      <div className="label-plate mb-3">Month-to-month consumption ({unit})</div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data}>
          <CartesianGrid stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="month" tick={{ fill: "var(--color-text-muted)", fontSize: 11 }} />
          <YAxis tick={{ fill: "var(--color-text-muted)", fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
            formatter={(value: unknown) => (typeof value === "number" ? `${fmt(value)} ${unit}` : "no data")}
          />
          <Bar dataKey="consumption" fill="var(--color-accent)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function MonthOverYearChart({
  years,
  getSeriesForYear,
  unit,
}: {
  years: number[];
  getSeriesForYear: (year: number) => PeriodConsumption[];
  unit: string;
}) {
  if (years.length === 0) return null;
  const data = MONTH_NAMES.map((name, i) => {
    const row: Record<string, string | number | null> = { month: name };
    for (const y of years) {
      row[String(y)] = getSeriesForYear(y)[i]?.consumption ?? null;
    }
    return row;
  });
  return (
    <div className="border border-border bg-surface p-4 mb-6">
      <div className="label-plate mb-3">Month-over-year comparison ({unit})</div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data}>
          <CartesianGrid stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="month" tick={{ fill: "var(--color-text-muted)", fontSize: 11 }} />
          <YAxis tick={{ fill: "var(--color-text-muted)", fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
          />
          {years.map((y, i) => (
            <Line
              key={y}
              type="monotone"
              dataKey={String(y)}
              stroke={YEAR_LINE_COLORS[i % YEAR_LINE_COLORS.length]}
              connectNulls={false}
              dot={{ r: 2 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrendChart({
  readings,
  unit,
  minThreshold,
  maxThreshold,
}: {
  readings: Reading[];
  unit: string;
  minThreshold: number | null;
  maxThreshold: number | null;
}) {
  const sorted = [...readings].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const data = sorted.map((r) => ({ date: formatDate(r.capturedAt), value: r.value }));
  if (data.length === 0) {
    return <div className="text-muted text-sm mb-6">No readings yet.</div>;
  }
  return (
    <div className="border border-border bg-surface p-4 mb-6">
      <div className="label-plate mb-3">Trend ({unit})</div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data}>
          <CartesianGrid stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="date" tick={{ fill: "var(--color-text-muted)", fontSize: 11 }} minTickGap={24} />
          <YAxis tick={{ fill: "var(--color-text-muted)", fontSize: 11 }} domain={["auto", "auto"]} />
          <Tooltip
            contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
          />
          {minThreshold != null && (
            <ReferenceLine
              y={minThreshold}
              stroke="var(--color-danger)"
              strokeDasharray="4 3"
              label={{ value: `min ${minThreshold}`, fill: "var(--color-danger)", fontSize: 11, position: "insideBottomLeft" }}
            />
          )}
          {maxThreshold != null && (
            <ReferenceLine
              y={maxThreshold}
              stroke="var(--color-danger)"
              strokeDasharray="4 3"
              label={{ value: `max ${maxThreshold}`, fill: "var(--color-danger)", fontSize: 11, position: "insideTopLeft" }}
            />
          )}
          <Line type="monotone" dataKey="value" stroke="var(--color-accent)" dot={{ r: 2 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const PRESSURE_STATUS_COPY: Record<string, { label: string; tone: "good" | "warn" | "danger" }> = {
  ok: { label: "Within range", tone: "good" },
  approaching_min: { label: "Trending toward minimum", tone: "warn" },
  approaching_max: { label: "Trending toward maximum", tone: "warn" },
  below_min: { label: "Below minimum threshold", tone: "danger" },
  above_max: { label: "Above maximum threshold", tone: "danger" },
};

/** Only rendered once at least one threshold is set (see MeterDetailView). */
function PressureStatusCallout({ readings, minThreshold, maxThreshold }: {
  readings: Reading[];
  minThreshold: number | null;
  maxThreshold: number | null;
}) {
  const result = computePressureTrend(readings, minThreshold, maxThreshold);
  if (result.status === "no_data" || result.status === "no_thresholds") return null;
  const copy = PRESSURE_STATUS_COPY[result.status];
  const toneVar =
    copy.tone === "danger" ? "var(--color-danger)" : copy.tone === "warn" ? "var(--color-warn)" : "var(--color-good)";
  return (
    <div className="border border-border bg-surface p-4 mb-6 flex items-center gap-3" style={{ borderLeftColor: toneVar, borderLeftWidth: 4 }}>
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: toneVar }} aria-hidden="true" />
      <div className="min-w-0">
        <div className="label-plate">{copy.label}</div>
        {(result.status === "approaching_min" || result.status === "approaching_max") && result.daysUntilCrossing != null && (
          <p className="text-sm mt-0.5">
            At the current rate, expected to cross in ≈{Math.round(result.daysUntilCrossing)} day
            {Math.round(result.daysUntilCrossing) === 1 ? "" : "s"} ({formatDate(result.predictedCrossingAt!)}).
          </p>
        )}
      </div>
    </div>
  );
}

interface EditReadingFormProps {
  reading: Reading;
  onDone: () => void;
}

function EditReadingForm({ reading, onDone }: EditReadingFormProps) {
  const [value, setValue] = useState(String(reading.value));
  const [capturedAt, setCapturedAt] = useState(isoToDatetimeLocal(reading.capturedAt));
  const [note, setNote] = useState(reading.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(value);
    if (!Number.isFinite(n)) {
      setError("Value must be a number.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await editReading(reading.id, {
        value: n,
        capturedAt: datetimeLocalToIso(capturedAt),
        note: note.trim() ? note.trim() : null,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save reading.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="pb-3 grid gap-2">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <label className="grid gap-1">
          <span className="label-plate">Value</span>
          <input
            type="number"
            step="any"
            className="border border-border bg-bg px-2 py-1.5"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Captured at</span>
          <input
            type="datetime-local"
            className="border border-border bg-bg px-2 py-1.5"
            value={capturedAt}
            onChange={(e) => setCapturedAt(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Note</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="border border-accent-strong bg-accent text-surface px-3 py-1 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="border border-border px-3 py-1 text-muted" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ReadingsList({ readings, unit, photoStatusByReading }: {
  readings: Reading[];
  unit: string;
  photoStatusByReading: Map<string, string>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const sorted = [...readings].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this reading? This can't be undone.")) return;
    setBusyId(id);
    try {
      await deleteReading(id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="border border-border bg-surface mb-6">
      <div className="p-4 border-b border-border label-plate">Readings</div>
      {sorted.length === 0 ? (
        <div className="px-4 py-3 text-sm text-muted">No readings logged yet.</div>
      ) : (
        <div className="divide-y divide-border">
          {sorted.map((r) => {
            const photoStatus = photoStatusByReading.get(r.id);
            const trailingBits = [
              r.photoBlobUrl ? "photo" : photoStatus && photoStatus !== "uploaded" ? `photo: ${photoStatus}` : null,
            ].filter(Boolean);
            return (
              <div key={r.id} className="px-4">
                <StatusRow
                  title={`${fmt(r.value)} ${unit}`}
                  meta={`${formatDate(r.capturedAt)}${r.note ? ` · ${r.note}` : ""}`}
                  tone="muted"
                  trailing={trailingBits.join(" ") || undefined}
                />
                {editingId === r.id ? (
                  <EditReadingForm reading={r} onDone={() => setEditingId(null)} />
                ) : (
                  <div className="pb-3 flex gap-3">
                    <button
                      className="label-plate text-accent hover:text-accent-strong"
                      onClick={() => setEditingId(r.id)}
                    >
                      Edit
                    </button>
                    <button
                      className="label-plate text-danger hover:opacity-80 disabled:opacity-50"
                      onClick={() => void handleDelete(r.id)}
                      disabled={busyId === r.id}
                    >
                      {busyId === r.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface LogReadingFormProps {
  meterId: string;
  unit: string;
}

function LogReadingForm({ meterId, unit }: LogReadingFormProps) {
  const [value, setValue] = useState("");
  const [capturedAt, setCapturedAt] = useState(nowDatetimeLocal());
  const [capturedAtTouched, setCapturedAtTouched] = useState(false);
  const [note, setNote] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setPhotoFile(file);
    if (!file) return;
    const exif = await extractExif(file);
    if (exif?.capturedAt && !capturedAtTouched) {
      setCapturedAt(isoToDatetimeLocal(exif.capturedAt));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(value);
    if (!Number.isFinite(n)) {
      setError("Value must be a number.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const exif = photoFile ? await extractExif(photoFile) : null;
      const reading = await createReading({
        meterId,
        value: n,
        capturedAt: datetimeLocalToIso(capturedAt),
        note: note.trim() ? note.trim() : null,
        photoExif: exif,
      });
      if (photoFile) {
        await storeLocalPhoto(reading.id, photoFile);
        // Fire-and-forget: uploadPendingPhoto never throws, and the
        // reading itself is already saved regardless of upload outcome.
        // Its progress is visible reactively via db.photoBlobs.
        void uploadPendingPhoto(reading.id);
      }
      setValue("");
      setNote("");
      setCapturedAt(nowDatetimeLocal());
      setCapturedAtTouched(false);
      setPhotoFile(null);
      const fileInput = document.getElementById(`photo-input-${meterId}`) as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save reading.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border bg-surface p-4 mb-6 grid gap-3">
      <div className="label-plate">Log a reading</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="grid gap-1">
          <span className="label-plate">Value ({unit})</span>
          <input
            type="number"
            step="any"
            className="border border-border bg-bg px-2 py-1.5"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Captured at</span>
          <input
            type="datetime-local"
            className="border border-border bg-bg px-2 py-1.5"
            value={capturedAt}
            onChange={(e) => {
              setCapturedAtTouched(true);
              setCapturedAt(e.target.value);
            }}
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Note (optional)</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>
      <label className="grid gap-1">
        <span className="label-plate">Photo (optional)</span>
        <input
          id={`photo-input-${meterId}`}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => void handlePhotoChange(e)}
          className="text-sm"
        />
      </label>
      {error && <div className="text-danger text-sm">{error}</div>}
      <button
        type="submit"
        disabled={submitting}
        className="justify-self-start border border-accent-strong bg-accent text-surface px-4 py-1.5 disabled:opacity-50"
      >
        {submitting ? "Saving…" : "Save reading"}
      </button>
    </form>
  );
}

function LogMeterEventForm({ meterId }: { meterId: string }) {
  const [open, setOpen] = useState(false);
  const [eventType, setEventType] = useState<MeterEventType>("replaced");
  const [occurredAt, setOccurredAt] = useState(nowDatetimeLocal());
  const [preEventFinalValue, setPreEventFinalValue] = useState("");
  const [postEventStartValue, setPostEventStartValue] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const pre = Number(preEventFinalValue);
    const post = Number(postEventStartValue);
    if (!Number.isFinite(pre) || !Number.isFinite(post)) {
      setError("Pre/post values must be numbers.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createMeterEvent({
        meterId,
        eventType,
        occurredAt: datetimeLocalToIso(occurredAt),
        preEventFinalValue: pre,
        postEventStartValue: post,
      });
      setOpen(false);
      setPreEventFinalValue("");
      setPostEventStartValue("0");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not log meter event.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button className="label-plate text-accent hover:text-accent-strong mb-6" onClick={() => setOpen(true)}>
        + Log meter reset / replacement
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border bg-surface p-4 mb-6 grid gap-3">
      <div className="label-plate">Log meter reset / replacement</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="grid gap-1">
          <span className="label-plate">Event type</span>
          <select
            className="border border-border bg-bg px-2 py-1.5"
            value={eventType}
            onChange={(e) => setEventType(e.target.value as MeterEventType)}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Occurred at</span>
          <input
            type="datetime-local"
            className="border border-border bg-bg px-2 py-1.5"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Pre-event final value</span>
          <input
            type="number"
            step="any"
            className="border border-border bg-bg px-2 py-1.5"
            value={preEventFinalValue}
            onChange={(e) => setPreEventFinalValue(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Post-event start value</span>
          <input
            type="number"
            step="any"
            className="border border-border bg-bg px-2 py-1.5"
            value={postEventStartValue}
            onChange={(e) => setPostEventStartValue(e.target.value)}
          />
        </label>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="justify-self-start border border-accent-strong bg-accent text-surface px-4 py-1.5 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save event"}
        </button>
        <button type="button" className="border border-border px-3 py-1.5 text-muted" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EditMeterForm({ meter, onDone }: { meter: Meter; onDone: () => void }) {
  const [name, setName] = useState(meter.name);
  const [type, setType] = useState<MeterType>(meter.type);
  const [unit, setUnit] = useState(meter.unit);
  const [readingInterval, setReadingInterval] = useState<ReadingInterval>(meter.readingInterval);
  const [readingKind, setReadingKind] = useState<ReadingKind>(meter.readingKind);
  const [minThreshold, setMinThreshold] = useState(meter.minThreshold != null ? String(meter.minThreshold) : "");
  const [maxThreshold, setMaxThreshold] = useState(meter.maxThreshold != null ? String(meter.maxThreshold) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !unit.trim()) {
      setError("Fill in a name and unit.");
      return;
    }
    const min = minThreshold.trim() ? Number(minThreshold) : null;
    const max = maxThreshold.trim() ? Number(maxThreshold) : null;
    if ((min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max))) {
      setError("Thresholds must be numbers.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await editMeter(meter.id, {
        name: name.trim(),
        type,
        unit: unit.trim(),
        readingInterval,
        readingKind,
        minThreshold: min,
        maxThreshold: max,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save meter.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${meter.name}"? Its readings stay recorded but the meter will no longer appear.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteMeter(meter.id);
      navigate("/meters");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete meter.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border bg-surface p-4 mb-6 grid gap-3">
      <div className="label-plate">Edit meter</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="grid gap-1">
          <span className="label-plate">Name</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Type</span>
          <select
            className="border border-border bg-bg px-2 py-1.5"
            value={type}
            onChange={(e) => setType(e.target.value as MeterType)}
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
                {i[0].toUpperCase() + i.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Reading kind</span>
          <select
            className="border border-border bg-bg px-2 py-1.5"
            value={readingKind}
            onChange={(e) => setReadingKind(e.target.value as ReadingKind)}
          >
            {READING_KINDS.map((k) => (
              <option key={k} value={k}>
                {k === "cumulative" ? "Cumulative (running counter)" : "Snapshot (point value)"}
              </option>
            ))}
          </select>
        </label>
      </div>
      {type === "pressure" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="grid gap-1">
            <span className="label-plate">Min threshold (optional)</span>
            <input
              type="number"
              step="any"
              className="border border-border bg-bg px-2 py-1.5"
              value={minThreshold}
              onChange={(e) => setMinThreshold(e.target.value)}
              placeholder="e.g. 1.0"
            />
          </label>
          <label className="grid gap-1">
            <span className="label-plate">Max threshold (optional)</span>
            <input
              type="number"
              step="any"
              className="border border-border bg-bg px-2 py-1.5"
              value={maxThreshold}
              onChange={(e) => setMaxThreshold(e.target.value)}
              placeholder="e.g. 2.5"
            />
          </label>
        </div>
      )}
      {error && <div className="text-danger text-sm">{error}</div>}
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="border border-accent-strong bg-accent text-surface px-4 py-1.5 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="border border-border px-3 py-1.5 text-muted" onClick={onDone} disabled={busy}>
            Cancel
          </button>
        </div>
        <button
          type="button"
          className="label-plate text-danger hover:opacity-80"
          onClick={() => void handleDelete()}
          disabled={busy}
        >
          Delete meter
        </button>
      </div>
    </form>
  );
}

function MeterDetailView({ meter }: { meter: Meter }) {
  const [editing, setEditing] = useState(false);
  const readings = useLiveQuery(
    () => db.readings.where("meterId").equals(meter.id).and((r) => r.deletedAt == null).toArray(),
    [meter.id]
  );
  const events = useLiveQuery(
    () => db.meterEvents.where("meterId").equals(meter.id).and((e) => e.deletedAt == null).toArray(),
    [meter.id]
  );
  const photoBlobs = useLiveQuery(() => db.photoBlobs.toArray(), []);
  const [range, setRange] = useDateRange();

  const readingList = readings ?? [];
  const eventList: MeterEvent[] = events ?? [];
  const photoStatusByReading = new Map((photoBlobs ?? []).map((p) => [p.readingId, p.uploadStatus]));

  const isCumulative = meter.readingKind === "cumulative";
  const rangeStartIso = monthInputToIsoStart(range.fromMonth);
  const rangeEndIso = monthInputToIsoEndExclusive(range.toMonth);
  const monthlySeries = isCumulative
    ? computeMonthlySeries(readingList, eventList, rangeStartIso, rangeEndIso)
    : [];
  const years = isCumulative ? yearsPresent([readingList]) : [];

  return (
    <div className="max-w-3xl mx-auto px-4 pt-8 pb-4 md:pt-12">
      <div className="mb-4">
        <Link to="/meters" className="label-plate text-muted hover:text-ink">
          ← Meters
        </Link>
      </div>
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <div className="label-plate">
            {meter.type} · {meter.readingKind} · every {meter.readingInterval}
          </div>
          <h1 className="font-display italic text-3xl md:text-4xl mt-1">{meter.name}</h1>
        </div>
        {!editing && (
          <button
            className="label-plate text-accent hover:text-accent-strong shrink-0"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
      </header>

      <div className="tick-rule mb-6" />

      {editing && <EditMeterForm meter={meter} onDone={() => setEditing(false)} />}

      <LogReadingForm meterId={meter.id} unit={meter.unit} />
      <LogMeterEventForm meterId={meter.id} />

      {(meter.minThreshold != null || meter.maxThreshold != null) && (
        <PressureStatusCallout
          readings={readingList}
          minThreshold={meter.minThreshold}
          maxThreshold={meter.maxThreshold}
        />
      )}

      <TrendChart
        readings={readingList}
        unit={meter.unit}
        minThreshold={meter.minThreshold}
        maxThreshold={meter.maxThreshold}
      />

      {isCumulative && (
        <>
          <div className="label-plate mb-1">Overview</div>
          <DateRangePicker range={range} onChange={setRange} />
          <OverviewStats series={monthlySeries} unit={meter.unit} />
          <MonthlyBarChart series={monthlySeries} unit={meter.unit} />
          <MonthOverYearChart
            years={years}
            unit={meter.unit}
            getSeriesForYear={(y) =>
              computeMonthlySeries(
                readingList,
                eventList,
                new Date(Date.UTC(y, 0, 1)).toISOString(),
                new Date(Date.UTC(y + 1, 0, 1)).toISOString()
              )
            }
          />
        </>
      )}

      <ReadingsList readings={readingList} unit={meter.unit} photoStatusByReading={photoStatusByReading} />
    </div>
  );
}

function EditGroupForm({ group, onDone }: { group: MeterGroup; onDone: () => void }) {
  const [name, setName] = useState(group.name);
  const [unit, setUnit] = useState(group.unit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !unit.trim()) {
      setError("Fill in a name and unit.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await editMeterGroup(group.id, { name: name.trim(), unit: unit.trim() });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save group.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${group.name}"? Its member meters are unaffected, only the grouping is removed.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteMeterGroup(group.id);
      navigate("/meters");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete group.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border bg-surface p-4 mb-6 grid gap-3">
      <div className="label-plate">Edit group</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="grid gap-1">
          <span className="label-plate">Name</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Unit</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          />
        </label>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="border border-accent-strong bg-accent text-surface px-4 py-1.5 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="border border-border px-3 py-1.5 text-muted" onClick={onDone} disabled={busy}>
            Cancel
          </button>
        </div>
        <button
          type="button"
          className="label-plate text-danger hover:opacity-80"
          onClick={() => void handleDelete()}
          disabled={busy}
        >
          Delete group
        </button>
      </div>
    </form>
  );
}

function GroupDetailView({ group, members }: { group: MeterGroup; members: MeterGroupMember[] }) {
  const [editing, setEditing] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const meterIds = members.map((m) => m.meterId);
  const meters = useLiveQuery(async (): Promise<(Meter | undefined)[]> => {
    if (meterIds.length === 0) return [];
    return db.meters.bulkGet(meterIds);
  }, [meterIds.join(",")]);
  const readings = useLiveQuery(async (): Promise<Reading[]> => {
    if (meterIds.length === 0) return [];
    return db.readings.where("meterId").anyOf(meterIds).and((r) => r.deletedAt == null).toArray();
  }, [meterIds.join(",")]);
  const events = useLiveQuery(async (): Promise<MeterEvent[]> => {
    if (meterIds.length === 0) return [];
    return db.meterEvents.where("meterId").anyOf(meterIds).and((e) => e.deletedAt == null).toArray();
  }, [meterIds.join(",")]);
  const [range, setRange] = useDateRange();

  const meterById = new Map((meters ?? []).filter((m): m is Meter => m != null).map((m) => [m.id, m]));
  const readingsByMeter = new Map<string, Reading[]>();
  for (const r of readings ?? []) {
    const list = readingsByMeter.get(r.meterId) ?? [];
    list.push(r);
    readingsByMeter.set(r.meterId, list);
  }
  const eventsByMeter = new Map<string, MeterEvent[]>();
  for (const e of events ?? []) {
    const list = eventsByMeter.get(e.meterId) ?? [];
    list.push(e);
    eventsByMeter.set(e.meterId, list);
  }

  function seriesForRange(startIso: string, endIso: string): PeriodConsumption[] {
    const memberSeries = members.map((m) => ({
      signMultiplier: m.signMultiplier,
      series: computeMonthlySeries(
        readingsByMeter.get(m.meterId) ?? [],
        eventsByMeter.get(m.meterId) ?? [],
        startIso,
        endIso
      ),
    }));
    return computeGroupSeries(memberSeries);
  }

  const rangeStartIso = monthInputToIsoStart(range.fromMonth);
  const rangeEndIso = monthInputToIsoEndExclusive(range.toMonth);
  const monthlySeries = seriesForRange(rangeStartIso, rangeEndIso);
  const years = yearsPresent([...readingsByMeter.values()]);

  return (
    <div className="max-w-3xl mx-auto px-4 pt-8 pb-4 md:pt-12">
      <div className="mb-4">
        <Link to="/meters" className="label-plate text-muted hover:text-ink">
          ← Meters
        </Link>
      </div>
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <div className="label-plate">Meter group · net of {members.length} member(s)</div>
          <h1 className="font-display italic text-3xl md:text-4xl mt-1">{group.name}</h1>
        </div>
        {!editing && (
          <button
            className="label-plate text-accent hover:text-accent-strong shrink-0"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
      </header>

      <div className="tick-rule mb-6" />

      {editing && <EditGroupForm group={group} onDone={() => setEditing(false)} />}

      <div className="border border-border bg-surface mb-6">
        <div className="p-4 border-b border-border label-plate">Members</div>
        <div className="divide-y divide-border">
          {members.map((m) => {
            const meter = meterById.get(m.meterId);
            return (
              <div key={m.id} className="flex items-center gap-2 hover:bg-bg">
                <Link to={`/meters/${m.meterId}`} className="flex-1 min-w-0">
                  <StatusRow
                    title={meter?.name ?? m.meterId}
                    meta={`${m.role} · sign ${m.signMultiplier > 0 ? "+" : ""}${m.signMultiplier}`}
                    tone="muted"
                  />
                </Link>
                <button
                  className="label-plate text-danger hover:opacity-80 disabled:opacity-50 pr-4 shrink-0"
                  disabled={removingId === m.id}
                  onClick={async () => {
                    if (!window.confirm(`Remove "${meter?.name ?? "this meter"}" from "${group.name}"?`)) return;
                    setRemovingId(m.id);
                    try {
                      await removeMeterGroupMember(m.id);
                    } finally {
                      setRemovingId(null);
                    }
                  }}
                >
                  {removingId === m.id ? "Removing…" : "Remove"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="label-plate mb-1">Overview</div>
      <DateRangePicker range={range} onChange={setRange} />
      <OverviewStats series={monthlySeries} unit={group.unit} />
      <MonthlyBarChart series={monthlySeries} unit={group.unit} />
      <MonthOverYearChart
        years={years}
        unit={group.unit}
        getSeriesForYear={(y) =>
          seriesForRange(new Date(Date.UTC(y, 0, 1)).toISOString(), new Date(Date.UTC(y + 1, 0, 1)).toISOString())
        }
      />
    </div>
  );
}

export default function MeterDetail() {
  const { id } = useParams<{ id: string }>();

  const meterMatch = useLiveQuery(async (): Promise<Meter[]> => {
    if (!id) return [];
    return db.meters.where("id").equals(id).toArray();
  }, [id]);
  const groupMatch = useLiveQuery(async (): Promise<MeterGroup[]> => {
    if (!id) return [];
    return db.meterGroups.where("id").equals(id).toArray();
  }, [id]);
  const groupMembers = useLiveQuery(async (): Promise<MeterGroupMember[]> => {
    if (!id) return [];
    return db.meterGroupMembers.where("groupId").equals(id).and((m) => m.deletedAt == null).toArray();
  }, [id]);

  if (!id) {
    return <div className="p-4 text-muted">No meter specified.</div>;
  }
  if (meterMatch === undefined || groupMatch === undefined) {
    return <div className="p-4 text-muted">Loading…</div>;
  }

  const meter = meterMatch.find((m) => m.deletedAt == null);
  if (meter) return <MeterDetailView meter={meter} />;

  const group = groupMatch.find((g) => g.deletedAt == null);
  if (group) return <GroupDetailView group={group} members={groupMembers ?? []} />;

  return (
    <div className="max-w-3xl mx-auto px-4 pt-8 pb-4 md:pt-12">
      <div className="mb-4">
        <Link to="/meters" className="label-plate text-muted hover:text-ink">
          ← Meters
        </Link>
      </div>
      <div className="text-muted">No meter or meter group found for id {id}.</div>
    </div>
  );
}
