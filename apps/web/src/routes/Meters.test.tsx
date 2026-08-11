import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Meters from "./Meters";
import { db } from "../db/dexie";
import { meter } from "../test/fixtures";

function renderMeters() {
  return render(
    <MemoryRouter>
      <Meters />
    </MemoryRouter>
  );
}

beforeEach(async () => {
  await db.meters.clear();
  await db.meterGroups.clear();
  await db.meterGroupMembers.clear();
  await db.outbox.clear();
});

describe("Meters list", () => {
  it("shows an empty state with no meters", async () => {
    renderMeters();
    expect(await screen.findByText("No meters yet — add one above.")).toBeInTheDocument();
  });

  it("lists seeded meters sorted by name, each linking to its detail page", async () => {
    await db.meters.bulkAdd([
      meter({ id: "meter-b", name: "Water", type: "water", unit: "gal" }),
      meter({ id: "meter-a", name: "Attic electricity", type: "electricity_in", unit: "kWh" }),
    ]);
    renderMeters();

    const rows = await screen.findAllByRole("link");
    const meterLinks = rows.filter((r) => r.getAttribute("href")?.startsWith("/meters/"));
    expect(meterLinks.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Attic electricity"),
      expect.stringContaining("Water"),
    ]);
    expect(meterLinks[0]).toHaveAttribute("href", "/meters/meter-a");
  });

  it("does not show a soft-deleted meter", async () => {
    await db.meters.add(meter({ name: "Old meter", deletedAt: "2024-06-01T00:00:00.000Z" }));
    renderMeters();
    expect(await screen.findByText("No meters yet — add one above.")).toBeInTheDocument();
  });
});

describe("New meter form", () => {
  it("creates a meter that immediately appears in the list", async () => {
    const user = userEvent.setup();
    renderMeters();

    await user.click(screen.getByRole("button", { name: "+ Add meter" }));
    await user.type(screen.getByPlaceholderText("Main electricity"), "Garage electricity");
    await user.clear(screen.getByPlaceholderText("kWh"));
    await user.type(screen.getByPlaceholderText("kWh"), "kWh");
    await user.click(screen.getByRole("button", { name: "Add meter" }));

    expect(await screen.findByText("Garage electricity")).toBeInTheDocument();
    const stored = await db.meters.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: "Garage electricity", unit: "kWh" });
  });

  it("rejects a name-less submission without touching Dexie", async () => {
    const user = userEvent.setup();
    renderMeters();

    await user.click(screen.getByRole("button", { name: "+ Add meter" }));
    await user.click(screen.getByRole("button", { name: "Add meter" }));

    expect(await screen.findByText("Fill in a name and unit.")).toBeInTheDocument();
    expect(await db.meters.count()).toBe(0);
  });
});

describe("Meter groups", () => {
  it("rejects adding a member whose unit doesn't match the group's unit", async () => {
    const user = userEvent.setup();
    await db.meters.add(meter({ id: "meter-water", name: "Well water", type: "water", unit: "gal" }));
    await db.meterGroups.add({
      id: "group-1",
      propertyId: "00000000-0000-0000-0000-000000000001",
      name: "Electricity (net)",
      unit: "kWh",
      updatedAt: "2024-01-01T00:00:00.000Z",
      deletedAt: null,
    });
    renderMeters();

    const groupSection = (await screen.findByText("Electricity (net)")).closest("div")!.parentElement!;
    await user.click(within(groupSection).getByRole("button", { name: "Add to group" }));

    expect(
      await screen.findByText(/uses unit "gal", but the group "Electricity \(net\)" uses "kWh"/)
    ).toBeInTheDocument();
    expect(await db.meterGroupMembers.count()).toBe(0);
  });

  it("adds a matching-unit member to a group", async () => {
    const user = userEvent.setup();
    await db.meters.add(meter({ id: "meter-solar", name: "Solar inverter", unit: "kWh" }));
    await db.meterGroups.add({
      id: "group-1",
      propertyId: "00000000-0000-0000-0000-000000000001",
      name: "Electricity (net)",
      unit: "kWh",
      updatedAt: "2024-01-01T00:00:00.000Z",
      deletedAt: null,
    });
    renderMeters();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add to group" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Add to group" }));

    await waitFor(async () => expect(await db.meterGroupMembers.count()).toBe(1));
    expect(await screen.findAllByText("Solar inverter")).toHaveLength(2); // once in the meter list, once as a group member
  });
});
