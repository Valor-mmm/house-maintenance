import { describe, it, expect } from "vitest";
import type { Meter, Reading, TaskInstance, TaskTemplate } from "@house/shared";
import { buildReadingsCsv, buildTasksCsv } from "./export";
import { meter as meterFixture, reading as readingFixture, taskInstance, taskTemplate } from "../test/fixtures";

describe("buildReadingsCsv", () => {
  it("emits a header row and one row per live reading, sorted oldest first", () => {
    const meters: Meter[] = [meterFixture({ id: "meter-1", name: "Main electricity", type: "electricity_in", unit: "kWh" })];
    const readings: Reading[] = [
      readingFixture({ id: "r2", meterId: "meter-1", value: 200, capturedAt: "2024-02-01T00:00:00.000Z" }),
      readingFixture({ id: "r1", meterId: "meter-1", value: 100, capturedAt: "2024-01-01T00:00:00.000Z" }),
    ];

    const csv = buildReadingsCsv(meters, readings);

    expect(csv).toBe(
      [
        "Meter,Type,Unit,Value,Captured at,Note",
        "Main electricity,electricity_in,kWh,100,2024-01-01T00:00:00.000Z,",
        "Main electricity,electricity_in,kWh,200,2024-02-01T00:00:00.000Z,",
      ].join("\r\n")
    );
  });

  it("excludes soft-deleted readings", () => {
    const meters = [meterFixture({ id: "meter-1" })];
    const readings = [readingFixture({ meterId: "meter-1", deletedAt: "2024-03-01T00:00:00.000Z" })];

    expect(buildReadingsCsv(meters, readings)).toBe("Meter,Type,Unit,Value,Captured at,Note");
  });

  it("keeps the meter's name for a reading whose meter was later soft-deleted", () => {
    const meters = [meterFixture({ id: "meter-1", name: "Old well pump", deletedAt: "2024-05-01T00:00:00.000Z" })];
    const readings = [readingFixture({ meterId: "meter-1", value: 42 })];

    expect(buildReadingsCsv(meters, readings)).toContain("Old well pump");
  });

  it("quotes a note containing a comma", () => {
    const meters = [meterFixture({ id: "meter-1", name: "Main electricity" })];
    const readings = [readingFixture({ meterId: "meter-1", note: "Reset, then re-read" })];

    expect(buildReadingsCsv(meters, readings)).toContain('"Reset, then re-read"');
  });
});

describe("buildTasksCsv", () => {
  it("emits a header row and one row per live instance, sorted by due date", () => {
    const templates: TaskTemplate[] = [taskTemplate({ id: "template-1", name: "Replace HVAC filter", category: "Furnace" })];
    const instances: TaskInstance[] = [
      taskInstance({
        id: "i1",
        templateId: "template-1",
        dueDate: "2024-01-01T00:00:00.000Z",
        completedAt: "2024-01-02T00:00:00.000Z",
        completedNote: "Done",
        cost: 24.99,
      }),
    ];

    const csv = buildTasksCsv(templates, instances);

    expect(csv).toBe(
      [
        "Task,Category,Due date,Completed at,Completed note,Cost",
        "Replace HVAC filter,Furnace,2024-01-01T00:00:00.000Z,2024-01-02T00:00:00.000Z,Done,24.99",
      ].join("\r\n")
    );
  });

  it("leaves completion columns blank for a still-pending instance", () => {
    const templates = [taskTemplate({ id: "template-1", name: "Clean gutters", category: "Exterior" })];
    const instances = [taskInstance({ templateId: "template-1", completedAt: null, completedNote: null, cost: null })];

    const csv = buildTasksCsv(templates, instances);

    expect(csv.split("\r\n")[1]).toBe("Clean gutters,Exterior,2024-01-01T00:00:00.000Z,,,");
  });

  it("excludes soft-deleted instances", () => {
    const templates = [taskTemplate({ id: "template-1" })];
    const instances = [taskInstance({ templateId: "template-1", deletedAt: "2024-03-01T00:00:00.000Z" })];

    expect(buildTasksCsv(templates, instances)).toBe("Task,Category,Due date,Completed at,Completed note,Cost");
  });
});
