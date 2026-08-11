import { test, expect } from "@playwright/test";
import { mockAnomalies, mockAuthenticatedSession, mockLoginFailure, mockLoginSuccess, mockSync } from "./mocks";

test("shows the server's error and stays on the login screen for bad credentials", async ({ page }) => {
  await mockLoginFailure(page, "Invalid username or password.");
  await page.goto("/login");

  await page.getByLabel("Username").fill("alice");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toHaveText("Invalid username or password.");
  await expect(page).toHaveURL(/\/login$/);
});

test("logs in and lands on the dashboard", async ({ page }) => {
  await mockLoginSuccess(page);
  await mockSync(page);
  await mockAnomalies(page);
  await page.goto("/login");

  await page.getByLabel("Username").fill("alice");
  await page.getByLabel("Password").fill("hunter2");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "My House" })).toBeVisible();
  await expect(page).toHaveURL("/");
});

test("redirects straight to the dashboard when already signed in", async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "My House" })).toBeVisible();
  await expect(page).toHaveURL("/");
});
