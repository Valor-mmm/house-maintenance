import { SEEDED_PROPERTY_ID, type Meter, type Reading, type TaskInstance, type TaskTemplate } from "@house/shared";

/** Builders for Dexie row fixtures, mirroring the `reading()` helper pattern in sync/engine.test.ts. */

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function meter(overrides: Partial<Meter> = {}): Meter {
  return {
    id: nextId("meter"),
    propertyId: SEEDED_PROPERTY_ID,
    name: "Main electricity",
    type: "electricity_in",
    unit: "kWh",
    readingInterval: "monthly",
    readingKind: "cumulative",
    minThreshold: null,
    maxThreshold: null,
    updatedAt: "2024-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

export function reading(overrides: Partial<Reading> = {}): Reading {
  return {
    id: nextId("reading"),
    meterId: "meter-1",
    value: 100,
    capturedAt: "2024-01-01T00:00:00.000Z",
    note: null,
    photoBlobUrl: null,
    photoExif: null,
    updatedAt: "2024-01-01T00:00:00.000Z",
    deletedAt: null,
    clientEditedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function taskTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: nextId("template"),
    propertyId: SEEDED_PROPERTY_ID,
    name: "Replace HVAC filter",
    category: "Furnace",
    recurrenceRule: { everyN: 3, unit: "months" },
    updatedAt: "2024-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

export function taskInstance(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    id: nextId("instance"),
    templateId: "template-1",
    dueDate: "2024-01-01T00:00:00.000Z",
    completedAt: null,
    completedNote: null,
    cost: null,
    lastNotifiedAt: null,
    updatedAt: "2024-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

export function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return new Response(JSON.stringify(body), { status });
}
