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
    // Not a second goto()-and-check-redirect: signInDirectly's
    // addInitScript re-injects the token on every navigation by design
    // (so authenticated specs stay signed in across page.reload()), which
    // would silently re-authenticate this test past the very thing it's
    // checking. Asserting the token itself is gone is the precise check;
    // "an unauthenticated visit redirects to /login" is already covered
    // by the sibling test above.
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("house-maintenance:token")))
      .toBeNull();
  });
});
