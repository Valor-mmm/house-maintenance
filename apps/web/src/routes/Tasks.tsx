// Owned by the "Maintenance tasks" feature slice. See the approved plan,
// Feature Scope #3.
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { SEEDED_PROPERTY_ID, type RecurrenceRule, type TaskInstance, type TaskTemplate } from "@house/shared";
import { db } from "../db/dexie";
import StatusRow, { type StatusRowProps } from "../components/StatusRow";
import {
  createTaskTemplate,
  completeTaskInstance,
  editTaskTemplate,
  deleteTaskTemplate,
  deleteTaskInstance,
} from "../data/tasks";

const RECURRENCE_UNITS: RecurrenceRule["unit"][] = ["days", "weeks", "months", "years"];
const DUE_SOON_WINDOW_DAYS = 7;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function daysUntil(iso: string): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const due = new Date(iso);
  const now = new Date();
  // Compare at day granularity so "due today" doesn't read as overdue.
  const dueDay = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((dueDay - nowDay) / msPerDay);
}

function dueTone(dueDate: string): NonNullable<StatusRowProps["tone"]> {
  const d = daysUntil(dueDate);
  if (d < 0) return "danger";
  if (d <= DUE_SOON_WINDOW_DAYS) return "warn";
  return "muted";
}

function dueTrailing(dueDate: string): string {
  const d = daysUntil(dueDate);
  if (d < 0) return `${Math.abs(d)}d over`;
  if (d === 0) return "due today";
  return `due ${formatDate(dueDate)}`;
}

function dueStatusLabel(dueDate: string): string {
  const d = daysUntil(dueDate);
  if (d < 0) return "Overdue";
  if (d <= DUE_SOON_WINDOW_DAYS) return "Due soon";
  return "On track";
}

function recurrenceLabel(rule: RecurrenceRule): string {
  if (rule.everyN === 1) {
    return `Every ${rule.unit.slice(0, -1)}`; // days -> day, weeks -> week, ...
  }
  return `Every ${rule.everyN} ${rule.unit}`;
}

function todayDateInputValue(): string {
  const now = new Date();
  const tz = now.getTimezoneOffset();
  const local = new Date(now.getTime() - tz * 60_000);
  return local.toISOString().slice(0, 10);
}

/** date-only input value ("YYYY-MM-DD") -> a full ISO datetime at local midnight. */
function dateInputToIso(value: string): string {
  return new Date(`${value}T00:00:00`).toISOString();
}

interface NewTemplateFormProps {
  onCreate: (input: {
    name: string;
    category: string;
    recurrenceRule: RecurrenceRule;
    firstDueDate: string;
  }) => Promise<void>;
}

function NewTemplateForm({ onCreate }: NewTemplateFormProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [everyN, setEveryN] = useState("1");
  const [unit, setUnit] = useState<RecurrenceRule["unit"]>("months");
  const [firstDueDate, setFirstDueDate] = useState(todayDateInputValue());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(everyN);
    if (!name.trim() || !category.trim() || !Number.isInteger(n) || n < 1) {
      setError("Fill in a name, category, and a whole-number recurrence interval of 1 or more.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        category: category.trim(),
        recurrenceRule: { everyN: n, unit },
        firstDueDate: dateInputToIso(firstDueDate),
      });
      setName("");
      setCategory("");
      setEveryN("1");
      setUnit("months");
      setFirstDueDate(todayDateInputValue());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create task template.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border bg-surface p-4 mb-8 grid gap-3">
      <div className="label-plate">New task template</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="grid gap-1">
          <span className="label-plate">Name</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Replace HVAC filter"
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Category</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Furnace"
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Repeats every</span>
          <div className="flex gap-2">
            <input
              type="number"
              min={1}
              step={1}
              className="border border-border bg-bg px-2 py-1.5 w-20"
              value={everyN}
              onChange={(e) => setEveryN(e.target.value)}
            />
            <select
              className="border border-border bg-bg px-2 py-1.5 flex-1"
              value={unit}
              onChange={(e) => setUnit(e.target.value as RecurrenceRule["unit"])}
            >
              {RECURRENCE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
        </label>
        <label className="grid gap-1">
          <span className="label-plate">First due</span>
          <input
            type="date"
            className="border border-border bg-bg px-2 py-1.5"
            value={firstDueDate}
            onChange={(e) => setFirstDueDate(e.target.value)}
          />
        </label>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <button
        type="submit"
        disabled={submitting}
        className="justify-self-start border border-accent-strong bg-accent text-surface px-4 py-1.5 disabled:opacity-50"
      >
        {submitting ? "Adding…" : "Add template"}
      </button>
    </form>
  );
}

function EditTemplateForm({ template, onDone }: { template: TaskTemplate; onDone: () => void }) {
  const [name, setName] = useState(template.name);
  const [category, setCategory] = useState(template.category);
  const [everyN, setEveryN] = useState(String(template.recurrenceRule.everyN));
  const [unit, setUnit] = useState<RecurrenceRule["unit"]>(template.recurrenceRule.unit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(everyN);
    if (!name.trim() || !category.trim() || !Number.isInteger(n) || n < 1) {
      setError("Fill in a name, category, and a whole-number recurrence interval of 1 or more.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await editTaskTemplate(template.id, {
        name: name.trim(),
        category: category.trim(),
        recurrenceRule: { everyN: n, unit },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save template.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        `Delete "${template.name}"? Any upcoming (not yet completed) occurrences will be removed too. Completed history stays.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteTaskTemplate(template.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete template.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="p-4 border-b border-border grid gap-3">
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
          <span className="label-plate">Category</span>
          <input
            className="border border-border bg-bg px-2 py-1.5"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="label-plate">Repeats every</span>
          <div className="flex gap-2">
            <input
              type="number"
              min={1}
              step={1}
              className="border border-border bg-bg px-2 py-1.5 w-20"
              value={everyN}
              onChange={(e) => setEveryN(e.target.value)}
            />
            <select
              className="border border-border bg-bg px-2 py-1.5 flex-1"
              value={unit}
              onChange={(e) => setUnit(e.target.value as RecurrenceRule["unit"])}
            >
              {RECURRENCE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
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
          Delete template
        </button>
      </div>
    </form>
  );
}

interface CompleteFormState {
  note: string;
  cost: string;
}

interface TemplateCardProps {
  template: TaskTemplate;
  instances: TaskInstance[];
}

function TemplateCard({ template, instances }: TemplateCardProps) {
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [form, setForm] = useState<CompleteFormState>({ note: "", cost: "" });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(false);
  const [removingInstanceId, setRemovingInstanceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRemoveInstance(instanceId: string) {
    if (!window.confirm("Remove this occurrence? This can't be undone.")) return;
    setRemovingInstanceId(instanceId);
    try {
      await deleteTaskInstance(instanceId);
    } finally {
      setRemovingInstanceId(null);
    }
  }

  const pending = instances
    .filter((i) => i.completedAt == null)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const history = instances
    .filter((i) => i.completedAt != null)
    .sort((a, b) => (b.completedAt as string).localeCompare(a.completedAt as string));

  function startComplete(instanceId: string) {
    setCompletingId(instanceId);
    setForm({ note: "", cost: "" });
    setError(null);
  }

  async function submitComplete(instanceId: string) {
    const trimmedCost = form.cost.trim();
    if (trimmedCost !== "" && (Number.isNaN(Number(trimmedCost)) || Number(trimmedCost) < 0)) {
      setError("Cost must be a non-negative number.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await completeTaskInstance(instanceId, {
        completedNote: form.note.trim() ? form.note.trim() : null,
        cost: trimmedCost === "" ? null : Number(trimmedCost),
      });
      setCompletingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-border bg-surface mb-6">
      {editingTemplate ? (
        <EditTemplateForm template={template} onDone={() => setEditingTemplate(false)} />
      ) : (
        <div className="p-4 border-b border-border">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-display text-lg">{template.name}</h3>
            <div className="flex items-baseline gap-3">
              <div className="label-plate">{recurrenceLabel(template.recurrenceRule)}</div>
              <button
                className="label-plate text-accent hover:text-accent-strong"
                onClick={() => setEditingTemplate(true)}
              >
                Edit
              </button>
            </div>
          </div>
          <div className="label-plate mt-1">{template.category}</div>
        </div>
      )}

      <div className="divide-y divide-border">
        {pending.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted">No upcoming occurrence.</div>
        )}
        {pending.map((instance) => (
          <div key={instance.id} className="px-4">
            <StatusRow
              title={template.name}
              meta={`${dueStatusLabel(instance.dueDate)} · ${template.category}`}
              tone={dueTone(instance.dueDate)}
              trailing={dueTrailing(instance.dueDate)}
            />
            {completingId === instance.id ? (
              <div className="pb-4 grid gap-2">
                <label className="grid gap-1">
                  <span className="label-plate">Note (optional)</span>
                  <input
                    className="border border-border bg-bg px-2 py-1.5"
                    value={form.note}
                    onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                    placeholder="Replaced with 20x25x1 filter"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="label-plate">Cost (optional)</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className="border border-border bg-bg px-2 py-1.5 w-32"
                    value={form.cost}
                    onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))}
                    placeholder="0.00"
                  />
                </label>
                {error && <div className="text-danger text-sm">{error}</div>}
                <div className="flex gap-2">
                  <button
                    className="border border-accent-strong bg-accent text-surface px-3 py-1 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void submitComplete(instance.id)}
                  >
                    {busy ? "Saving…" : "Save"}
                  </button>
                  <button
                    className="border border-border px-3 py-1 text-muted"
                    disabled={busy}
                    onClick={() => setCompletingId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="pb-3 flex gap-3">
                <button
                  className="label-plate text-accent hover:text-accent-strong"
                  onClick={() => startComplete(instance.id)}
                >
                  Mark complete
                </button>
                <button
                  className="label-plate text-danger hover:opacity-80 disabled:opacity-50"
                  disabled={removingInstanceId === instance.id}
                  onClick={() => void handleRemoveInstance(instance.id)}
                >
                  {removingInstanceId === instance.id ? "Removing…" : "Remove"}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-border">
        <button
          className="label-plate w-full text-left px-4 py-2 text-muted hover:text-ink"
          onClick={() => setHistoryOpen((v) => !v)}
        >
          {historyOpen ? "Hide history" : `History (${history.length})`}
        </button>
        {historyOpen && (
          <div className="px-4 pb-2 divide-y divide-border">
            {history.length === 0 && (
              <div className="py-3 text-sm text-muted">Nothing completed yet.</div>
            )}
            {history.map((instance) => (
              <StatusRow
                key={instance.id}
                title={instance.completedNote?.trim() || "Completed"}
                meta={`Completed ${formatDate(instance.completedAt as string)}`}
                tone="muted"
                trailing={instance.cost != null ? `$${instance.cost.toFixed(2)}` : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Tasks() {
  const templates = useLiveQuery(
    () =>
      db.taskTemplates
        .where("propertyId")
        .equals(SEEDED_PROPERTY_ID)
        .and((t) => t.deletedAt == null)
        .toArray(),
    []
  );
  const instances = useLiveQuery(
    () => db.taskInstances.filter((i) => i.deletedAt == null).toArray(),
    []
  );

  const instancesByTemplate = new Map<string, TaskInstance[]>();
  for (const instance of instances ?? []) {
    const list = instancesByTemplate.get(instance.templateId) ?? [];
    list.push(instance);
    instancesByTemplate.set(instance.templateId, list);
  }

  async function handleCreate(input: {
    name: string;
    category: string;
    recurrenceRule: RecurrenceRule;
    firstDueDate: string;
  }) {
    await createTaskTemplate(input);
  }

  const sortedTemplates = [...(templates ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="max-w-3xl mx-auto px-4 pt-8 pb-4 md:pt-12">
      <header className="mb-6">
        <div className="label-plate">House Maintenance</div>
        <h1 className="font-display italic text-3xl md:text-4xl mt-1">Tasks</h1>
      </header>

      <div className="tick-rule mb-6" />

      <NewTemplateForm onCreate={handleCreate} />

      {templates === undefined ? (
        <div className="text-muted text-sm">Loading…</div>
      ) : sortedTemplates.length === 0 ? (
        <div className="text-muted text-sm">No task templates yet — add one above.</div>
      ) : (
        sortedTemplates.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            instances={instancesByTemplate.get(template.id) ?? []}
          />
        ))
      )}
    </div>
  );
}
