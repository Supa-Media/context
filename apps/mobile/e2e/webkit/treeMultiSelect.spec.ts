import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * PICKING SEVERAL ROWS IN THE FILE TREE, WITH A REAL POINTER.
 *
 * `__tests__/treeInteractions.test.ts` dispatches synthetic clicks in jsdom,
 * which proves the capture listener wins the race to react-native-web's
 * `Pressable` there. It cannot show what a real engine does with a real
 * modified click: whether the browser's own reaction to a shift-click (a text
 * selection from the last click to this one) is stopped, and whether the
 * picked rows are actually drawn selected. That is this file.
 *
 * `ControlOrMeta` is Playwright's name for the key `isApplePlatform` picks:
 * ⌘ on a Mac and ctrl everywhere else, including CI's Linux runner.
 *
 * `?screen=app-frame-visual` mounts the real `Explorer` over the demo tree,
 * with `canEdit` on and every mutating method a no-op, so a menu can be opened
 * and read and nothing can be written anywhere.
 */

const FRAME = "/e2e-fixture?screen=app-frame-visual";

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

/** Every row that can be picked up: the file and folder rows, in tree order. */
function rows(page: Page): Locator {
  return page.getByTestId("explorer-tree").locator('[draggable="true"]');
}

/** Whether any row's text is selected in the page. */
async function textSelected(page: Page): Promise<string> {
  return await page.evaluate(() => window.getSelection()?.toString() ?? "");
}

test.beforeEach(async ({ page }) => {
  await page.goto(FRAME);
  await page.getByTestId("explorer-tree").waitFor();
  expect(await rows(page).count()).toBeGreaterThanOrEqual(3);
});

test("⌘/ctrl-clicking two rows picks both, and right-clicking one offers the plural menu", async ({
  page,
}) => {
  await rows(page).nth(0).click({ modifiers: ["ControlOrMeta"] });
  await rows(page).nth(1).click({ modifiers: ["ControlOrMeta"] });
  await rows(page).nth(1).click({ button: "right" });

  await expect(page.getByText("Move 2 items to trash")).toBeVisible();
  await expect(page.getByText("Move 2 items to…")).toBeVisible();
});

/** The row drawing exactly this name. */
function row(page: Page, name: string): Locator {
  return rows(page).filter({ has: page.getByText(name, { exact: true }) });
}

test("shift-click picks the range between, and starts no text selection", async ({ page }) => {
  // Three closed folders side by side at the root, so nothing in the range is
  // inside anything else in it — a note inside a picked folder travels with
  // the folder and is not counted twice (`topmost`).
  await row(page, "areas").click({ modifiers: ["ControlOrMeta"] });
  await row(page, "archive").click({ modifiers: ["Shift"] });

  expect(await textSelected(page)).toBe("");

  await row(page, "resources").click({ button: "right" });
  await expect(page.getByText("Move 3 items to trash")).toBeVisible();
});

test("a note inside a picked folder travels with it rather than counting twice", async ({
  page,
}) => {
  // `projects` is open and holds the open note. Picking the folder and the
  // note is one move: the folder.
  await row(page, "projects").click({ modifiers: ["ControlOrMeta"] });
  await row(page, "inbox").click({ modifiers: ["ControlOrMeta"] });
  await row(page, "inbox").click({ button: "right" });

  await expect(page.getByText("Move 2 items to trash")).toBeVisible();
});

test("Escape puts the pick down", async ({ page }) => {
  await rows(page).nth(0).click({ modifiers: ["ControlOrMeta"] });
  await rows(page).nth(1).click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("Escape");
  await rows(page).nth(1).click({ button: "right" });

  await expect(page.getByText("Move to trash", { exact: true })).toBeVisible();
  await expect(page.getByText("Move 2 items to trash")).toHaveCount(0);
});
