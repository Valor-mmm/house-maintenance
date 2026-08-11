import { test, expect } from "@playwright/test";
import { mockAuthenticatedSession } from "./mocks";

test.beforeEach(async ({ page }) => {
  await mockAuthenticatedSession(page);
});

test("creates a meter that survives a reload (Dexie persistence, not just React state)", async ({ page }) => {
  await page.goto("/meters");

  await page.getByRole("button", { name: "+ Add meter" }).click();
  await page.getByPlaceholder("Main electricity").fill("Garage electricity");
  await page.getByRole("button", { name: "Add meter", exact: true }).click();

  await expect(page.getByText("Garage electricity")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Garage electricity")).toBeVisible();
});

test("creates a task template and marks its first occurrence complete", async ({ page }) => {
  await page.goto("/tasks");

  await page.getByPlaceholder("Replace HVAC filter").fill("Clean gutters");
  await page.getByPlaceholder("Furnace").fill("Exterior");
  await page.getByRole("button", { name: "Add template" }).click();

  await expect(page.getByRole("heading", { name: "Clean gutters" })).toBeVisible();

  await page.getByRole("button", { name: "Mark complete" }).click();
  await page.getByRole("button", { name: "Save" }).click();

  // Completing a recurring task's instance immediately generates its next
  // occurrence (see completeTaskInstance in src/data/tasks.ts) — so the
  // pending list is never empty here. The complete note moves to history.
  await page.getByRole("button", { name: /History \(1\)/ }).click();
  await expect(page.getByText(/^Completed \w+ \d+, \d{4}$/)).toBeVisible();
});
