import { expect, test } from "@playwright/test";

/*
  The landing pages (Dev, 2026-10-11): `/` is page a and `/a` to `/c` are the
  three versions under test. a is a page of prose in the shape of the two
  references Dev sent, selling less chaos by showing AI helpers sorting a cluttered life into workspaces;
  b is the landing page `/` showed until then, kept as it was; c is the console's own shell, which every page of the website
  (`/?page=…`) still is. `/d` and `/e`, retired, send a visit to `/`.
*/

test("/ is page a: Tex, the feeling, a day being sorted, and the phone sign-up under one line", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^Context is an app that gives your brain that feeling you have when your room is clean/,
  );
  // Nothing wider than the window.
  const wide = await page.locator(".sp").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(wide).toBeLessThanOrEqual(1);
  // Tex, the graph and its Pause all fit the first screen, so nobody scrolls to see what is going on.
  await expect(page.locator(".sp-tex svg")).toBeVisible();
  const graph = page.locator("canvas.sp-graph");
  await expect(graph).toBeVisible();
  const bottom = await page.getByRole("button", { name: "Pause" }).evaluate((el) => el.getBoundingClientRect().bottom);
  expect(bottom).toBeLessThanOrEqual(900);
  // The canvas is drawn on, and the visitor can pause it.
  const inked = (el: HTMLCanvasElement) => {
    const { data } = el.getContext("2d")!.getImageData(0, 0, el.width, el.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
    return n;
  };
  await expect.poll(() => graph.evaluate(inked), { timeout: 5_000 }).toBeGreaterThan(2_000);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  await expect(page.getByLabel("Phone number")).toHaveCount(0);
  await page.getByRole("button", { name: /Join the waitlist/ }).click();
  await expect(page.locator("#join").getByLabel("Phone number")).toBeVisible();
});

test("page a fits a laptop window with no scrolling, the sign-up open too", async ({ page }) => {
  // Dev2, 2026-10-12: "everything should fit on the page without scrolling".
  for (const [width, height] of [
    [1280, 720],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.locator("[data-landing=a]")).toBeVisible({ timeout: 15_000 });
    const overflow = () => page.locator(".sp").evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(await overflow()).toBeLessThanOrEqual(1);
    const foot = await page.locator(".sp-foot").evaluate((el) => el.getBoundingClientRect().bottom);
    expect(foot).toBeLessThanOrEqual(height);
    await page.getByRole("button", { name: /Join the waitlist/ }).click();
    await expect(page.locator("#join").getByLabel("Phone number")).toBeFocused();
    expect(await overflow()).toBeLessThanOrEqual(1);
    const send = await page.getByRole("button", { name: "Text me a code" }).evaluate((el) => el.getBoundingClientRect().bottom);
    expect(send).toBeLessThanOrEqual(height);
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
  await page.goto("/?page=pricing");
  await expect(page.locator(".cm-content").first()).toContainText("Pricing", { timeout: 15_000 });
  await expect(page.locator("[data-landing]")).toHaveCount(0);
});
