import { expect, test, type Page } from "@playwright/test";

/**
 * THE FILE TREE'S HEADER DOES NOT CHANGE WHEN A POINTER ARRIVES.
 *
 * It used to: entering the column faded `Notes` out, boxed an invisible filter
 * field under it and faded in two more buttons, so the header redrew every
 * time somebody reached for a note. The owner asked for it to stay the same
 * (2026-09-26), and the header is now `Notes` plus Filter, New and View, drawn
 * once — see `ExplorerToolbar.tsx`.
 *
 * This is here and not in the unit suite because the claim is about a real
 * pointer: `View`'s `onPointerEnter` is a pointer event and jsdom defines no
 * `PointerEvent`, so only an engine can show that hovering the column leaves
 * the header exactly as it was. `__tests__/explorerChrome.test.ts` holds the
 * structure and the presses.
 *
 * `?screen=app-frame-visual` mounts the real `Explorer` inside the real
 * `AppFrame` (`features/e2e/AppFrameVisualFixture.tsx`). Nothing here can
 * reach an account or a bucket.
 */

const FRAME = "/e2e-fixture?screen=app-frame-visual";

/*
  A pointer context, declared rather than resized into: the suite's default is
  a phone with touch emulation, and hover on a surface the engine believes is a
  touchscreen is the behaviour under test.
*/
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

/** Every node in the header: its box, its opacity and its text. */
async function header(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const root = document.querySelector('[data-testid="explorer-header"]');
    if (root === null) throw new Error("no explorer header on this screen");
    return [root, ...root.querySelectorAll("*")]
      .map((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return [
          node.getAttribute("data-testid") ?? node.tagName,
          Math.round(box.x),
          Math.round(box.y),
          Math.round(box.width),
          Math.round(box.height),
          style.opacity,
          node.children.length === 0 ? (node.textContent ?? "") : "",
        ].join(" ");
      })
      .join("\n");
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto(FRAME);
  await page.getByTestId("explorer-tree").waitFor();
  // Park the pointer somewhere that is not the column, so "at rest" is a state
  // rather than wherever the previous action left it.
  await page.mouse.move(1200, 500);
});

test("at rest the header is the column's name and three lit buttons", async ({ page }) => {
  await expect(page.getByTestId("explorer-header")).toContainText("Notes");
  for (const id of ["explorer-filter-toggle", "explorer-new", "explorer-view"]) {
    expect(await page.getByTestId(id).isVisible()).toBe(true);
  }
  expect(await page.getByTestId("explorer-filter").count()).toBe(0);
});

test("the pointer entering the column leaves the header exactly as it was", async ({ page }) => {
  const before = await header(page);

  await page.getByTestId("explorer-tree").hover();
  // Longer than any fade this header ever had, so a transition in flight
  // cannot pass for a header that did not move.
  await page.waitForTimeout(300);
  expect(await header(page)).toBe(before);

  await page.mouse.move(1200, 500);
  await page.waitForTimeout(300);
  expect(await header(page)).toBe(before);
});

test("the filter is a press away, and the tree does not move when it opens", async ({ page }) => {
  const tree = page.getByTestId("explorer-tree");
  const treeBefore = await tree.boundingBox();

  await page.getByTestId("explorer-filter-toggle").click();
  const field = page.getByTestId("explorer-filter");
  await expect(field).toBeFocused();
  await expect(page.getByTestId("explorer-header")).not.toContainText("Notes");

  const treeAfter = await tree.boundingBox();
  if (treeBefore === null || treeAfter === null) throw new Error("no box for the tree");
  expect(treeAfter.y).toBe(treeBefore.y);

  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(page.getByTestId("explorer-header")).toContainText("Notes");
});

test("pressing the lit magnifier on an empty field closes it rather than reopening it", async ({
  page,
}) => {
  // The field blurs on mousedown and puts itself away before the press lands;
  // the press must not read that as "closed" and open it again.
  await page.getByTestId("explorer-filter-toggle").click();
  await expect(page.getByTestId("explorer-filter")).toBeFocused();

  await page.getByTestId("explorer-filter-toggle").click();
  await expect(page.getByTestId("explorer-filter")).toHaveCount(0);
  await expect(page.getByTestId("explorer-header")).toContainText("Notes");
});
