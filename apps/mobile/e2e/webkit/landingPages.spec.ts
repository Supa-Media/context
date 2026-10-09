import { expect, test } from "@playwright/test";

/*
  The landing pages (Dev2, 2026-10-09): `/` is page a and `/a` to `/e` are
  the five versions under test, each with the sign-in page's phone-first
  sign-up. The website's own pages, its home page among them, are still the
  console's frame at `/?page=…`.
*/

test("/ is landing page a, with the phone sign-up a tap away", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1, name: /^Less chaos/ })).toBeVisible();
  await expect(page.getByLabel("Phone number")).toHaveCount(1);
  // The map is a picture: the page under it still scrolls.
  await expect(page.locator("[data-landing=a] canvas").first()).toBeAttached();
});

for (const letter of ["b", "c", "d", "e"]) {
  test(`/${letter} is its own landing page`, async ({ page }) => {
    await page.goto(`/${letter}`);
    await expect(page.locator(`[data-landing=${letter}]`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Phone number")).toBeVisible();
  });
}

test("the website's pages, its home page too, are still the console's frame", async ({ page }) => {
  await page.goto("/?page=index");
  await expect(page.locator(".cm-content").first()).toContainText("Notes for your team", { timeout: 15_000 });
  await expect(page.locator("[data-landing]")).toHaveCount(0);
  await page.goto("/?page=pricing");
  await expect(page.locator(".cm-content").first()).toContainText("Pricing", { timeout: 15_000 });
  await expect(page.locator("[data-landing]")).toHaveCount(0);
});
