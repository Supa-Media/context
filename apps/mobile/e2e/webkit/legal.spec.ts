import { expect, test } from "@playwright/test";

test("public privacy and terms pages render from the exported web app", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();
  await expect(page.getByText("Google API Services User Data Policy")).toBeVisible();
  await expect(page.getByText("context@supa.media").first()).toBeVisible();

  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Google integrations" })).toBeVisible();
  await expect(page.getByText("context@supa.media").first()).toBeVisible();
});
