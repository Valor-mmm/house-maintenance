import { test, expect } from "@playwright/test";
import { mockAuthenticatedSession } from "./mocks";

test("redirects an unauthenticated visitor to the login screen", async ({ page }) => {
  await page.goto("/meters");
  await expect(page).toHaveURL(/\/login$/);
});

test.describe("authenticated", () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedSession(page);
  });

  test("moves between Dashboard, Meters, Tasks and Backups via the bottom nav", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "My House" })).toBeVisible();

    await page.getByRole("link", { name: "Meters" }).click();
    await expect(page.getByRole("heading", { name: "Meters" })).toBeVisible();
    await expect(page).toHaveURL("/meters");

    await page.getByRole("link", { name: "Tasks" }).click();
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await expect(page).toHaveURL("/tasks");

    await page.getByRole("link", { name: "Backups" }).click();
    await expect(page.getByRole("heading", { name: "Backups" })).toBeVisible();
    await expect(page).toHaveURL("/backups");

    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByRole("heading", { name: "My House" })).toBeVisible();
  });

  test("logging out sends the user back to the login screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "My House" })).toBeVisible();

    await page.getByRole("button", { name: "Log out" }).click();

    await expect(page).toHaveURL(/\/login$/);
    // logout() clears the session_present marker cookie itself (client-side,
    // synchronous, not httpOnly) as its first step — see auth/token.ts.
    await expect
      .poll(async () => {
        const cookies = await page.context().cookies();
        return cookies.some((c) => c.name === "session_present");
      })
      .toBe(false);
  });
});
