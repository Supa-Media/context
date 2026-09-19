import { expect, test } from "@playwright/test";
import { tap } from "./helpers";

/**
 * A TABLE THAT WAS ALREADY IN THE NOTE, ON THE CONSOLE'S OWN SCREEN.
 *
 * `tableEditing.test.ts` mounts an `EditorView` and drives the grid under
 * jsdom, and `editorFormatting.spec.ts` makes a table from the right-click
 * menu. Neither answers the question this file exists for, and the decision
 * log names both halves of why:
 *
 *  - *A control mounted by nobody passes every test of itself.* A grid drawn
 *    by a view a test constructed says nothing about the screen a person
 *    opens. Here the note is reached by pressing through the real tree.
 *  - *A fixture that cannot show the thing under review is reporting on
 *    itself.* Until `2-areas/public-worship/org-chart.md` carried a table
 *    there was nowhere in the running app to look at one, and a table
 *    somebody has to make first is not the same screen as a table that was
 *    already in the file.
 *
 * Both visual defects this file pins were invisible to 7,500 passing checks
 * and obvious in a browser: the control bar was drawn over the paragraph above
 * the table and cut in half by the grid's own scroller, and on a narrow table
 * it wrapped every label into its own column and drew "+ r o w" on top of
 * "+ c o l".
 *
 * See `playwright.config.ts` for what a `chromium` run of this proves and does
 * not; a pass there is never reported as a WebKit result.
 */

/** The grid drawn for the note's own table, and its first body row's cells. */
const GRID = ".cm-lp-grid-live";

/** From the fixture's landing note to the one carrying a table. */
async function openOrgChart(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/e2e-fixture");
  await page.getByTestId("note-scroll").waitFor();
  await tap(page, "@seyi, the context you are in — open its root");
  await page.getByTestId("folder-row").first().waitFor();
  await tap(page, "areas, folder");
  await tap(page, "public-worship, folder");
  await tap(page, "org-chart");
  await page.getByTestId("breadcrumb-leaf").waitFor();
}

test.describe("a table already in the note", () => {
  test.beforeEach(async ({ page }) => {
    await openOrgChart(page);
  });

  test("is drawn as a grid while the note is being written", async ({ page }) => {
    // The note is editable — this is the screen somebody writes on, not
    // reading mode — and the pipes are a table rather than a paragraph.
    const grid = page.locator(GRID).first();
    await expect(grid).toBeVisible();
    // By the cells' own marker rather than by `th`: the handle gutter and the
    // strip above the header are table cells too, and only the content cells
    // carry a row and column.
    await expect(grid.locator('[data-lp-row="-1"]')).toHaveText(["Seat", "Holder", "Backup"]);
    await expect(grid.locator("tbody tr")).toHaveCount(2);
    await expect(page.locator(".cm-content")).not.toContainText("| --- |");
  });

  test("a cell takes the caret, shows its source, and keeps its markup", async ({ page }) => {
    const holder = page.locator('[data-lp-row="0"][data-lp-column="1"]');
    // Drawn as the note reads it: the asterisks are not on screen.
    await expect(holder).toHaveText("Sayo");

    await holder.click();
    // In the cell you are in, the markup is back — the reveal rule, at the
    // size of a cell.
    await expect(holder).toHaveText("**Sayo**");

    await page.keyboard.type("!");
    await page.keyboard.press("Escape");
    // And what was written back is the source, not the rendering: a widget
    // that wrote what it drew would have left `Sayo!` and lost the bold.
    await expect(holder).toHaveText("Sayo!");
    await expect(holder.locator(".cm-lp-strong")).toHaveText("Sayo");
  });

  test("the keyboard's accessory bar is up while a cell has the caret", async ({ page }) => {
    /*
      A cell is `contenteditable` DOM belonging to a widget, so `contentDOM`
      does not have focus while somebody types in one. Both halves used to
      report that as a blur, and on this surface the accessory bar is the only
      way back out of the keyboard.
    */
    await page.locator('[data-lp-row="0"][data-lp-column="0"]').click();
    await expect(page.getByTestId("note-accessory")).toBeVisible();
  });

});

/**
 * The chrome is a pointer affordance, so it is looked at with a pointer —
 * the same override and the same reasoning as `editorFormatting.spec.ts`.
 *
 * The table is **typed** here rather than opened, because at this width the
 * fixture console draws the note and its breadcrumb and no tree, so
 * `openWeeklyReview`'s walk does not exist to be pressed. Typing the pipes is
 * also the other half of the feature: a table becomes a grid as the row is
 * finished, with nobody choosing a size from a menu.
 */
test.describe("the grid's own controls", () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

  test.beforeEach(async ({ page }) => {
    await page.goto("/e2e-fixture");
    await page.locator(".cm-content").waitFor();
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\n| Folder | Left | Owner |\n| --- | --- | --- |\n| 0-inbox | 4 | me |\n| 1-projects | 2 | me |");
    // Park the caret away from it: a table being typed is left as its own
    // pipes, which the case below this one is about.
    await page.keyboard.press("ControlOrMeta+Home");
    await page.locator(GRID).first().waitFor();
  });

  test("typing one by hand leaves the pipes alone until the caret leaves", async ({ page }) => {
    /*
      The defect only a browser found: `| - | - |` parses as a table in the
      middle of typing the dashes, so the grid appeared over the two lines
      being written and the rest of the row went in off screen. Measured in
      Chromium before the fix, `| --- | --- |` finished as `-- |` under a
      two-column grid.
    */
    await page.keyboard.press("ControlOrMeta+End");
    // A blank line first: typed straight under the table the setup made, these
    // rows would join it rather than start one.
    await page.keyboard.type("\n\n| x | y |\n| --- | --- |");
    await expect(page.locator(".cm-content")).toContainText("| --- | --- |");

    await page.keyboard.type("\n| 1 | 2 |");
    await expect(page.locator(".cm-content")).toContainText("| 1 | 2 |");

    // And it is a grid with that row in it the moment the caret is elsewhere.
    await page.keyboard.press("ControlOrMeta+Home");
    const last = page.locator(GRID).last();
    await expect(last.locator("tbody tr")).toHaveCount(1);
    await expect(last.locator('[data-lp-row="-1"]')).toHaveText(["x", "y"]);
  });

  test("a row handle appears with its row and deletes that row", async ({ page }) => {
    /*
      THE REPORT THIS CHROME EXISTS FOR: "deleting a row is not really
      possible". What it replaced was a bar acting on the last cell that had
      the caret — disabled until one had, and then armed with a remembered
      row long after the caret had left the table. Measured in Chromium,
      both: the obvious gesture did nothing, and the recovered one deleted a
      row nobody was pointing at.

      Here the handle belongs to the row. No cell is focused first.
    */
    const grid = page.locator(GRID).first();
    const handle = page.getByRole("button", { name: "Row 1 actions" });
    await expect(handle).toHaveCSS("opacity", "0");

    await grid.locator('[data-lp-row="0"]').first().hover();
    await expect(handle).toHaveCSS("opacity", "1");

    await handle.click();
    const menu = page.locator(".cm-lp-grid-menu");
    await expect(menu).toBeVisible();
    // The row it is about is marked on the table, not only in the wording.
    await expect(grid.locator('[data-lp-row="0"]').first()).toHaveClass(/cm-lp-grid-target/);

    await menu.getByRole("menuitem", { name: "Delete row" }).click();
    await expect(grid.locator("tbody tr")).toHaveCount(1);
    await expect(grid.locator('[data-lp-row="0"][data-lp-column="0"]')).toHaveText("1-projects");
  });

  test("the menu is drawn in the note's own palette, outside the note", async ({ page }) => {
    /*
      A menu on the document body is outside the element the `--lp-*` palette
      is declared on, and an unknown custom property invalidates its whole
      declaration rather than falling back. In the browser that was a menu
      with no background at all and the note's text showing through it — the
      same defect the decision log records as "white text on a white ground".
    */
    await page.getByRole("button", { name: "Row 1 actions" }).click();
    const menu = page.locator(".cm-lp-grid-menu");
    const paint = await menu.evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, size: Number.parseFloat(style.fontSize) };
    });
    expect(paint.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(paint.size).toBeGreaterThan(10);
  });

  test("a column handle sets the alignment, which has no other route", async ({ page }) => {
    // The delimiter row is where GFM keeps alignment and the grid never draws
    // it, so before the column menu there was no way to set it from the app.
    await page.getByRole("button", { name: "Column 2 actions" }).click();
    await page.getByRole("menuitem", { name: "Align right" }).click();

    const cell = page.locator(GRID).first().locator('[data-lp-row="0"][data-lp-column="1"]');
    await expect(cell).toHaveCSS("text-align", "right");
    // And the header of that column travels with it.
    await expect(
      page.locator(GRID).first().locator('[data-lp-row="-1"][data-lp-column="1"]'),
    ).toHaveCSS("text-align", "right");
  });

  test("the corner hands back the pipes, which is the way out of anything else", async ({ page }) => {
    await page.getByRole("button", { name: "Table actions" }).click();
    await page.getByRole("menuitem", { name: "Edit as text" }).click();
    await expect(page.locator(".cm-content")).toContainText("| --- | --- | --- |");
    await expect(page.locator(GRID)).toHaveCount(0);
  });

  test("Escape closes a menu and leaves the table alone", async ({ page }) => {
    const grid = page.locator(GRID).first();
    await page.getByRole("button", { name: "Row 2 actions" }).click();
    await expect(page.locator(".cm-lp-grid-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".cm-lp-grid-menu")).toHaveCount(0);
    await expect(grid.locator("tbody tr")).toHaveCount(2);
    await expect(grid.locator(".cm-lp-grid-target")).toHaveCount(0);
  });

  test("undo takes back a row the menu deleted, from inside a cell", async ({ page }) => {
    /*
      A destructive control is only safe to press if the press can be taken
      back, and ⌘Z inside a cell used to reach the browser's contenteditable
      history rather than the document's.
    */
    const grid = page.locator(GRID).first();
    await page.getByRole("button", { name: "Row 1 actions" }).click();
    await page.getByRole("menuitem", { name: "Delete row" }).click();
    await expect(grid.locator("tbody tr")).toHaveCount(1);

    await grid.locator('[data-lp-row="0"][data-lp-column="0"]').click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(grid.locator("tbody tr")).toHaveCount(2);
  });
});
