import { expect, test } from "@playwright/test";

/*
  The landing pages (Dev, 2026-10-11): `/` is page a and `/a` to `/c` are the
  three versions under test. a is the notes page (Dev2, 2026-10-21: "context.lc's
  homepage should look more notes focused", now tex.lc has the texting page):
  the editor, a workspace per part of your life for free, and Tex linking to
  tex.lc; b is the landing page `/` showed until 2026-10-11, kept as it was; c
  is the console's own shell, which every page of the website (`/?page=…`)
  still is. `/d` and `/e`, retired, send a visit to `/`.
*/

test("/ is page a: Dev2's words first, the sign-up, the editor, free workspaces, and Tex at tex.lc", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Context gives your brain that feeling you have when your room is clean\.$/);
  const wide = await page.locator(".np").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(wide).toBeLessThanOrEqual(1);
  // The sign-up is open from the start, asks for an email (tex.lc is the
  // texting one), and its button says what it does.
  await expect(page.getByLabel("Join the waitlist")).toHaveAttribute("type", "email");
  await expect(page.locator(".tp-cc")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Join the waitlist" })).toBeVisible();
  await expect(page.getByRole("region", { name: "The Context editor, with an example note" })).toContainText("Supper club");
  await expect(page.getByRole("heading", { name: "A workspace for each part of your life. Free." })).toBeAttached();
  await expect(page.getByRole("link", { name: "Meet Tex at tex.lc →" })).toHaveAttribute("href", "https://tex.lc");
  // No conversation is drawn: texting is tex.lc's page.
  await expect(page.locator(".tp-chat")).toHaveCount(0);
});

test("making a workspace goes to the sign-up", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: "Make your first workspace" }).click();
  await expect(page.getByRole("button", { name: "Join the waitlist" })).toBeInViewport();
});

test("the sign-up is in the first screen, on a laptop and on a phone, and nothing is wider than the screen", async ({ page }) => {
  for (const [width, height] of [
    [1280, 720],
    [1440, 900],
    [375, 667],
    [390, 844],
    [430, 932],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
    const wide = await page.locator(".np").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(wide).toBeLessThanOrEqual(1);
    const field = await page.locator(".tp-field").evaluate((el) => el.getBoundingClientRect());
    const join = await page.getByRole("button", { name: "Join the waitlist" }).evaluate((el) => el.getBoundingClientRect());
    expect(join.bottom).toBeLessThanOrEqual(height);
    if (width < 600) {
      // The button sits under the field, so the address has the whole width.
      expect(join.top).toBeGreaterThanOrEqual(field.bottom);
      expect(field.width).toBeGreaterThan(width - 60);
    }
  }
});

test("/b is the page / showed before, with the map and the real editor playing a demo", async ({ page }) => {
  await page.goto("/b");
  await expect(page.locator("[data-landing=b]")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1, name: /^Less chaos/ })).toBeVisible();
  await expect(page.locator("[data-landing=b] canvas").first()).toBeAttached();
  await expect(page.getByLabel("Phone number")).toHaveCount(1);
  const section = page.getByRole("region", { name: /A Markdown editor/ });
  await section.scrollIntoViewIfNeeded({ timeout: 15_000 });
  const stage = page.frameLocator(".lp-editor iframe");
  await expect(stage.getByText("Launch plan").first()).toBeVisible({ timeout: 20_000 });
});

test("page b's statement is centred on a wide screen", async ({ page }) => {
  // A reset with more weight than `.lp-stmt` once dropped its `margin: 0 auto`,
  // pinning the statement to the left edge (Dev2, 2026-10-09).
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/b");
  const statement = page.locator(".lp-stmt");
  await expect(statement).toBeAttached({ timeout: 15_000 });
  const box = await statement.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: window.innerWidth - r.right };
  });
  expect(Math.abs(box.left - box.right)).toBeLessThan(24);
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
  await page.goto("/?page=your-files");
  await expect(page.locator(".cm-content").first()).toContainText("Your files", { timeout: 15_000 });
  await expect(page.locator("[data-landing]")).toHaveCount(0);
});
