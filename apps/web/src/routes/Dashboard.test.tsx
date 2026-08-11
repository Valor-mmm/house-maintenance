import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { meter, reading, taskInstance, taskTemplate, jsonResponse } from "../test/fixtures";

const authFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
vi.mock("../auth/token", () => ({ authFetch: (...args: [string, RequestInit?]) => authFetch(...args) }));

const { db } = await import("../db/dexie");
const Dashboard = (await import("./Dashboard")).default;

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>
  );
}

beforeEach(async () => {
  authFetch.mockReset();
  authFetch.mockResolvedValue(jsonResponse([])); // no anomalies by default
  await db.meters.clear();
  await db.readings.clear();
  await db.taskTemplates.clear();
  await db.taskInstances.clear();
  localStorage.clear();
});

describe("Dashboard", () => {
  it("shows the all-caught-up state with nothing due", async () => {
    renderDashboard();
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    expect(await screen.findByText("No meters yet.")).toBeInTheDocument();
  });

  it("lists an overdue task in Needs attention and counts it in the Overdue gauge", async () => {
    const template = taskTemplate({ id: "template-1", name: "Replace HVAC filter", category: "Furnace" });
    await db.taskTemplates.add(template);
    await db.taskInstances.add(
      taskInstance({ templateId: "template-1", dueDate: "2020-01-01T00:00:00.000Z" })
    );
    renderDashboard();

    expect(await screen.findByText("Replace HVAC filter")).toBeInTheDocument();
    expect(screen.getByText(/Overdue · Furnace/)).toBeInTheDocument();
  });

  it("flags a meter as due for a reading when none has ever been logged", async () => {
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity" }));
    renderDashboard();

    expect(await screen.findByText("Main electricity reading")).toBeInTheDocument();
    expect(screen.getByText("never read")).toBeInTheDocument();
  });

  it("does not flag a meter whose last reading is within its interval", async () => {
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity", readingInterval: "monthly" }));
    await db.readings.add(
      reading({ meterId: "meter-1", capturedAt: new Date().toISOString(), value: 42 })
    );
    renderDashboard();

    await waitFor(() => expect(screen.getByText("All caught up")).toBeInTheDocument());
  });

  it("surfaces an unacknowledged anomaly from the server", async () => {
    authFetch.mockResolvedValue(
      jsonResponse([
        {
          id: "anomaly-1",
          meterId: "meter-1",
          meterGroupId: null,
          targetName: "Main electricity",
          periodStart: "2024-05-01T00:00:00.000Z",
          periodEnd: "2024-06-01T00:00:00.000Z",
          computedValue: 500,
          baselineValue: 300,
          pctOver: 0.667,
          notifiedAt: null,
          acknowledgedAt: null,
        },
      ])
    );
    renderDashboard();

    expect(await screen.findByText(/Main electricity consumption 67% above trend/)).toBeInTheDocument();
  });

  it("shows an error message when the anomalies request fails, without crashing the rest of the page", async () => {
    authFetch.mockResolvedValue(jsonResponse({ error: "server error" }, false, 500));
    renderDashboard();

    expect(await screen.findByText(/Anomalies couldn't be loaded/)).toBeInTheDocument();
    expect(screen.getByText("All caught up")).toBeInTheDocument();
  });

  it("collapses and expands the meters overview, persisting the choice", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    await db.meters.add(meter({ id: "meter-1", name: "Main electricity" }));
    renderDashboard();

    await screen.findByText("Main electricity");
    const toggle = screen.getByRole("button", { name: /Meters \(1\)/ });
    await user.click(toggle);

    expect(screen.queryByText("Main electricity")).not.toBeInTheDocument();
    expect(localStorage.getItem("dashboard.metersCollapsed")).toBe("1");
  });
});
