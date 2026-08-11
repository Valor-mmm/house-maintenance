import { test, expect } from "@playwright/test";
import { mockAuthenticatedSession } from "./mocks";

test.beforeEach(async ({ page }) => {
  await mockAuthenticatedSession(page);
});

test("exports a logged reading as a downloadable CSV containing the meter and value", async ({ page }) => {
  await page.goto("/meters");
  await page.getByRole("button", { name: "+ Add meter" }).click();
  await page.getByPlaceholder("Main electricity").fill("Garage electricity");
  await page.getByRole("button", { name: "Add meter", exact: true }).click();
  await page.getByText("Garage electricity").click();

  await page.getByLabel("Value (kWh)").fill("321.5");
  await page.getByRole("button", { name: "Save reading" }).click();
  await expect(page.getByText("321.5 kWh")).toBeVisible();

  await page.goto("/backups");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export readings (CSV)" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^house-maintenance-readings-\d{4}-\d{2}-\d{2}\.csv$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const content = Buffer.concat(chunks).toString("utf-8");

  expect(content).toContain("Meter,Type,Unit,Value,Captured at,Note");
  expect(content).toContain("Garage electricity,electricity_in,kWh,321.5,");
});
