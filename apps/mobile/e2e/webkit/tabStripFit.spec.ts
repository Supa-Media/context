import { expect, test, type Page } from "@playwright/test";

/**
 * A FULL TAB STRIP SHRINKS ITS TABS; IT NEVER RUNS UNDER THE SEARCH FIELD.
 *
 * It did (owner, 2026-10-20): the strip took its tabs' natural width, ran out
 * of the title bar's slot and drew a sixth and seventh tab across the search
 * field and the icons beside it. Now the tabs share the row the way Chrome's
 * do — see `TabStrip.tsx`'s `SHARE` and `tabsAreTight` — and only scroll once
 * every one is down to its first letters.
 *
 * A layout claim, so it is here and not in `__tests__/tabStrip.test.ts`:
 * jsdom lays nothing out. `?tabs=N` opens N tabs in the real frame
 * (`features/e2e/AppFrameVisualFixture.tsx`), the last one active.
 */

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

interface Tab {
  left: number;
  right: number;
  width: number;
  /** Whether a ✕ is in the row at all, faded or not. */
  close: boolean;
  /** Whether the ✕ is drawn — the front tab's always is. */
  closeShown: boolean;
}

async function measure(page: Page, tabs: number): Promise<{ tabs: Tab[]; strip: DOMRect; search: DOMRect }> {
  await page.goto(`/e2e-fixture?screen=app-frame-visual&tabs=${tabs}`);
  await page.getByTestId("tab-strip").waitFor();
  await page.waitForTimeout(200);
  return await page.evaluate(() => {
    const rect = (node: Element | null) => {
      if (node === null) throw new Error("missing node");
      return node.getBoundingClientRect().toJSON() as DOMRect;
    };
    const items = [...document.querySelectorAll('[data-testid="tab-strip-track"] > [data-testid^="tab-1-projects/"]')];
    return {
      strip: rect(document.querySelector('[data-testid="tab-strip"]')),
      search: rect(document.querySelector('[data-testid="frame-search"]')),
      tabs: items.map((item) => {
        const box = item.getBoundingClientRect();
        const close = item.querySelector('[data-testid^="tab-close-"]');
        return {
          left: box.left,
          right: box.right,
          width: box.width,
          close: close !== null,
          closeShown: close !== null && getComputedStyle(close).opacity !== "0",
        };
      }),
    };
  });
}

test("a few tabs keep their natural widths", async ({ page }) => {
  const few = await measure(page, 2);
  const one = await measure(page, 1);
  // Opening a second tab does not squeeze the first.
  expect(Math.round(few.tabs[0].width)).toBe(Math.round(one.tabs[0].width));
});

for (const count of [7, 14, 30]) {
  test(`${count} tabs stay clear of the search field`, async ({ page }) => {
    const { tabs, strip, search } = await measure(page, count);
    expect(strip.right).toBeLessThanOrEqual(search.left);
    // What is drawn at the search field's leading edge is the search field,
    // whether the tabs fit or are scrolled past the strip's end.
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="frame-search"]') !== null,
      [search.left + 4, search.top + search.height / 2],
    );
    expect(hit).toBe(true);
    if (count <= 14) for (const tab of tabs) expect(tab.right).toBeLessThanOrEqual(strip.right + 0.5);
  });
}

test("each tab gets smaller the more are open", async ({ page }) => {
  // The back tabs: the front one stops at its own, wider floor.
  const widest = (tabs: Tab[]) => Math.max(...tabs.slice(0, -1).map((tab) => tab.width));
  const seven = widest((await measure(page, 7)).tabs);
  const fourteen = widest((await measure(page, 14)).tabs);
  const twenty = widest((await measure(page, 20)).tabs);
  expect(fourteen).toBeLessThan(seven);
  expect(twenty).toBeLessThan(fourteen);
});

test("squeezed back tabs are letters only, and the front one keeps its ✕", async ({ page }) => {
  const { tabs } = await measure(page, 20);
  const front = tabs[tabs.length - 1];
  expect(front.closeShown).toBe(true);
  expect(front.width).toBeGreaterThanOrEqual(112);
  for (const tab of tabs.slice(0, -1)) {
    expect(tab.close).toBe(false);
    expect(tab.width).toBeGreaterThanOrEqual(44);
  }
});

test("past the floor the strip scrolls, and the front tab is in view", async ({ page }) => {
  const { strip } = await measure(page, 40);
  const front = page.locator('[data-testid="tab-strip-track"] > *').last();
  // The scroll that brings it in is animated, so wait for it to land.
  await expect
    .poll(async () => {
      const box = await front.boundingBox();
      return box === null ? Infinity : box.x + box.width;
    })
    .toBeLessThanOrEqual(strip.right + 0.5);
  expect((await front.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(strip.left - 0.5);
});
