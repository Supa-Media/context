import { expect, test } from "@playwright/test";

/*
  The landing pages (Dev, 2026-10-11): `/` is page a and `/a` to `/c` are the
  three versions under test. a and b are one sentence ("Tell Claude. ChatGPT
  already knows.", its names retyped live) and the phone-first sign-up; c is the console's own shell, which every page of the website
  (`/?page=…`) still is. `/d` and `/e`, retired, send a visit to `/`.
*/

test("/ is landing page a: one sentence and the phone sign-up, on one screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
  // One h1, and what it says to assistive tech holds still while the names are retyped.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("Tell Claude. ChatGPT already knows.");
  await expect(page.locator("#join").getByLabel("Phone number")).toHaveCount(1);
  // Simple means nothing to scroll past on a laptop.
  const overflow = await page.locator(".lp").evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("/b is the map, labelled as a demo, beside the sign-up", async ({ page }) => {
  await page.goto("/b");
  await expect(page.locator("[data-landing=b]")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-landing=b] canvas").first()).toBeAttached();
  await expect(page.getByText(/^Demo: made-up people/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("Tell Claude. ChatGPT already knows.");
  await expect(page.getByLabel("Phone number")).toBeVisible();
});

test("/c is the console's own shell, its home page in visitor mode", async ({ page }) => {
  await page.goto("/c");
  await expect(page.locator(".cm-content").first()).toContainText("Notes for your team", { timeout: 15_000 });
  await expect(page.locator("[data-landing]")).toHaveCount(0);
});

for (const letter of ["d", "e"]) {
  test(`/${letter}, retired, lands on page a`, async ({ page }) => {
    await page.goto(`/${letter}`);
    await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/$/);
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
