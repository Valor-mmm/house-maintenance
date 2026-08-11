import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Tasks from "./Tasks";
import { db } from "../db/dexie";
import { taskTemplate, taskInstance } from "../test/fixtures";

function renderTasks() {
  return render(
    <MemoryRouter>
      <Tasks />
    </MemoryRouter>
  );
}

beforeEach(async () => {
  await db.taskTemplates.clear();
  await db.taskInstances.clear();
  await db.outbox.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Tasks list", () => {
  it("shows an empty state with no templates", async () => {
    renderTasks();
    expect(await screen.findByText("No task templates yet — add one above.")).toBeInTheDocument();
  });

  it("shows a pending instance as overdue when its due date has passed", async () => {
    const template = taskTemplate({ id: "template-1", name: "Replace HVAC filter" });
    await db.taskTemplates.add(template);
    await db.taskInstances.add(taskInstance({ templateId: "template-1", dueDate: "2020-01-01T00:00:00.000Z" }));
    renderTasks();

    expect(await screen.findByRole("heading", { name: "Replace HVAC filter" })).toBeInTheDocument();
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
  });
});

describe("New task template form", () => {
  it("creates a template that appears with no pending occurrence message suppressed once an instance exists", async () => {
    const user = userEvent.setup();
    renderTasks();

    await user.type(screen.getByPlaceholderText("Replace HVAC filter"), "Clean gutters");
    await user.type(screen.getByPlaceholderText("Furnace"), "Exterior");
    await user.click(screen.getByRole("button", { name: "Add template" }));

    expect(await screen.findByText("Clean gutters")).toBeInTheDocument();
    const stored = await db.taskTemplates.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: "Clean gutters", category: "Exterior" });
  });

  it("rejects submission without a name or category", async () => {
    const user = userEvent.setup();
    renderTasks();

    await user.click(screen.getByRole("button", { name: "Add template" }));

    expect(
      await screen.findByText("Fill in a name, category, and a whole-number recurrence interval of 1 or more.")
    ).toBeInTheDocument();
    expect(await db.taskTemplates.count()).toBe(0);
  });
});

describe("Completing an instance", () => {
  beforeEach(async () => {
    await db.taskTemplates.add(taskTemplate({ id: "template-1", name: "Replace HVAC filter" }));
    await db.taskInstances.add(
      taskInstance({ id: "instance-1", templateId: "template-1", dueDate: "2020-01-01T00:00:00.000Z" })
    );
  });

  it("moves the instance into history with the note and cost once marked complete", async () => {
    const user = userEvent.setup();
    renderTasks();

    await user.click(await screen.findByRole("button", { name: "Mark complete" }));
    await user.type(screen.getByPlaceholderText("Replaced with 20x25x1 filter"), "New filter installed");
    await user.type(screen.getByPlaceholderText("0.00"), "24.99");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("No upcoming occurrence.")).toBeInTheDocument();

    const stored = await db.taskInstances.get("instance-1");
    expect(stored?.completedAt).not.toBeNull();
    expect(stored).toMatchObject({ completedNote: "New filter installed", cost: 24.99 });

    await user.click(screen.getByRole("button", { name: "History (1)" }));
    expect(screen.getByText("New filter installed")).toBeInTheDocument();
    expect(screen.getByText("$24.99")).toBeInTheDocument();
  });

  it("rejects a negative cost", async () => {
    const user = userEvent.setup();
    renderTasks();

    await user.click(await screen.findByRole("button", { name: "Mark complete" }));
    await user.type(screen.getByPlaceholderText("0.00"), "-5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Cost must be a non-negative number.")).toBeInTheDocument();
    expect((await db.taskInstances.get("instance-1"))?.completedAt).toBeNull();
  });

  it("removes an instance after confirmation", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const user = userEvent.setup();
    renderTasks();

    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(await screen.findByText("No upcoming occurrence.")).toBeInTheDocument();
    expect((await db.taskInstances.get("instance-1"))?.deletedAt).not.toBeNull();
  });

  it("keeps the instance when removal is not confirmed", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const user = userEvent.setup();
    renderTasks();

    await screen.findByRole("heading", { name: "Replace HVAC filter" });
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect((await db.taskInstances.get("instance-1"))?.deletedAt).toBeNull();
  });
});
