import { test, expect } from "@playwright/test";
import { mockAuthenticatedSession } from "./mocks";

test("shows the offline badge when connectivity drops, and hides it again when it returns", async ({
  page,
  context,
}) => {
  await mockAuthenticatedSession(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My House" })).toBeVisible();
  await expect(page.getByText("Offline — changes saved locally")).not.toBeVisible();

  await context.setOffline(true);
  await expect(page.getByText("Offline — changes saved locally")).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText("Offline — changes saved locally")).not.toBeVisible();
});
