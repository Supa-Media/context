import { expect, test } from "@playwright/test";

/*
  The landing pages (Dev, 2026-10-11): `/` is page a and `/a` to `/c` are the
  three versions under test. a is the Tex page (Dev, 2026-10-18): "Text your
  notes", one conversation with Tex, and a sign-up whose button says what it
  does; b is the landing page `/` showed until 2026-10-11, kept as it was; c is
  the console's own shell, which every page of the website (`/?page=…`) still
  is. `/d` and `/e`, retired, send a visit to `/`.
*/

test("/ is page a: Tex, Dev's line, a conversation with Tex, and a sign-up with a real button", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Text your notes\. We'll organize them\.$/);
  // Nothing wider than the window.
  const wide = await page.locator(".tp").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(wide).toBeLessThanOrEqual(1);
  await expect(page.locator(".tp-tex svg")).toBeVisible();
  // No graph any more: the picture is the conversation, and it plays to its end.
  await expect(page.locator("[data-landing=a] canvas")).toHaveCount(0);
  const chat = page.getByRole("region", { name: "An example conversation with Tex" });
  await expect(chat).toBeVisible();
  await expect(chat.locator(".tp-live .tp-b")).toHaveCount(9, { timeout: 20_000 });
  await expect(chat).toContainText("Text YES to send");
  // The sign-up is open from the start, +1 already there, and its button says what it does.
  await expect(page.getByLabel("Join the waitlist")).toBeVisible();
  await expect(page.locator(".tp-cc")).toContainText("+1");
  await expect(page.getByRole("button", { name: "Join the waitlist" })).toBeVisible();
});

test("a visitor who asks for less motion sees the whole conversation at once", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".tp-live .tp-b")).toHaveCount(9);
  await context.close();
});

test("page a fits a laptop window with no scrolling, the sign-up and the conversation included", async ({ page }) => {
  // Dev2, 2026-10-12: "everything should fit on the page without scrolling".
  for (const [width, height] of [
    [1280, 720],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
    const overflow = () => page.locator(".tp").evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(await overflow()).toBeLessThanOrEqual(1);
    for (const selector of [".tp-foot", ".tp-chat", ".tp-go"]) {
      const bottom = await page.locator(selector).evaluate((el) => el.getBoundingClientRect().bottom);
      expect(bottom).toBeLessThanOrEqual(height);
    }
  }
});

test("on a phone the sign-up comes before the conversation and nothing is wider than the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
  const wide = await page.locator(".tp").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(wide).toBeLessThanOrEqual(1);
  const join = await page.getByRole("button", { name: "Join the waitlist" }).evaluate((el) => el.getBoundingClientRect());
  const chat = await page.locator(".tp-chat").evaluate((el) => el.getBoundingClientRect().top);
  expect(join.bottom).toBeLessThan(chat);
  expect(join.bottom).toBeLessThanOrEqual(844);
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
  await page.goto("/?page=pricing");
  await expect(page.locator(".cm-content").first()).toContainText("Pricing", { timeout: 15_000 });
  await expect(page.locator("[data-landing]")).toHaveCount(0);
});
