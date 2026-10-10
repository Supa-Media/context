import { expect, test, type Page } from "@playwright/test";

/**
 * A PROJECTS FOLDER'S LIST, LAID OUT BY A REAL ENGINE.
 *
 * Since 2026-10-10 the List is the Notes rows with three thin extras (a status
 * dot, a grey "2/3", the owners' faces; the owner chose board 11 after calling
 * the older List "pretty cluttered"). jsdom has no layout, so only a browser
 * can hold what matters about it: the extras sit on the row's one line, after
 * the name, and the name keeps its room. The side peek a writer types in still
 * exists, and opens from a Board card. `?screen=projects` is the real
 * `FolderView` on an in-memory folder (`features/e2e/projects/`).
 */

const PAGE = "/e2e-fixture?screen=projects";

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

async function open(page: Page, query = "") {
  await page.goto(`${PAGE}${query}`);
  await page.getByTestId("folder-row").first().waitFor();
}

async function openBoard(page: Page, query = "") {
  await open(page, query);
  await page.getByTestId("folder-view-board").click();
  await page.getByTestId("folder-card").first().waitFor();
}

const cardNamed = (page: Page, name: string) => page.getByTestId("folder-card").filter({ hasText: name }).first();

test("the List is the Notes rows: one line each, extras after the name, and nothing above them", async ({ page }) => {
  await open(page);
  for (const gone of ["folder-groups", "folder-show-bar", "folder-add-task", "folder-item"]) {
    await expect(page.getByTestId(gone)).toHaveCount(0);
  }
  const rows = page.getByTestId("folder-row");
  expect(await rows.count()).toBeGreaterThanOrEqual(5);
  let withExtras = 0;
  for (const row of await rows.all()) {
    const box = (await row.boundingBox())!;
    // A Notes row's height: the extras never push it onto a second line.
    expect(box.height).toBeLessThan(48);
    const extras = row.getByTestId("folder-row-extras");
    if ((await extras.count()) === 0) continue;
    withExtras += 1;
    const trail = (await extras.boundingBox())!;
    // At the row's end, inside it, and leaving the name most of the row.
    expect(trail.x + trail.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(trail.width).toBeLessThan(box.width / 3);
    expect(trail.y).toBeGreaterThanOrEqual(box.y - 1);
    expect(trail.y + trail.height).toBeLessThanOrEqual(box.y + box.height + 1);
  }
  expect(withExtras).toBeGreaterThan(0);
});

test("a writer types in the side peek opened from a Board card, and it is saved", async ({ page }) => {
  await openBoard(page);
  await cardNamed(page, "Togather").click();
  const editor = page.getByTestId("task-panel").locator(".cm-content");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Typed beside the board.");
  await expect(page.getByTestId("fixture-save-mark")).toContainText("Saved");
  await page.getByTestId("task-panel-close").click();
  await cardNamed(page, "Togather").click();
  await expect(page.getByTestId("task-panel")).toContainText("Typed beside the board.");
});

test("a member reads the side peek and cannot type in it", async ({ page }) => {
  await openBoard(page, "&role=member");
  await cardNamed(page, "Togather").click();
  await expect(page.getByTestId("task-panel-body")).toBeVisible();
  const editor = page.getByTestId("task-panel").locator(".cm-content");
  await expect(editor).not.toHaveAttribute("contenteditable", "true");
});
