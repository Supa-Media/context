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
    await expect(grid.locator("th")).toHaveText(["Seat", "Holder", "Backup"]);
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
    await expect(last.locator("th")).toHaveText(["x", "y"]);
  });

  test("appear on hover and are laid out in one row", async ({ page }) => {
    const grid = page.locator(GRID).first();
    const bar = page.locator(".cm-lp-grid-controls").first();
    await expect(bar).toHaveCSS("opacity", "0");

    await grid.locator("table").hover();
    await expect(bar).toHaveCSS("opacity", "1");

    /*
      Side by side, which is the assertion the wrapped-label defect fails: an
      absolutely positioned bar cannot be wider than the frame it is in, and a
      frame that shrank to a narrow table stacked each label down its own
      column. Same top, four different lefts.
    */
    const boxes = await bar.locator("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { top: Math.round(box.top), left: Math.round(box.left), height: box.height };
      }),
    );
    expect(boxes).toHaveLength(4);
    expect(new Set(boxes.map((box) => box.top)).size).toBe(1);
    expect(new Set(boxes.map((box) => box.left)).size).toBe(4);
    // One line of text each, rather than a label folded onto four.
    for (const box of boxes) expect(box.height).toBeLessThan(32);
  });

  test("sit inside the grid's own box, not over the line above it", async ({ page }) => {
    /*
      The bar was pinned outside the frame with a negative offset, which drew
      it across the last line of the paragraph above and then had it clipped in
      half by this box — `overflow-x: auto` makes the other axis a clip too.
      The space is reserved now, so the whole bar is inside the grid.
    */
    const grid = page.locator(GRID).first();
    await grid.locator("table").hover();
    const outer = await grid.boundingBox();
    const bar = await page.locator(".cm-lp-grid-controls").first().boundingBox();
    const table = await grid.locator("table").boundingBox();
    if (outer === null || bar === null || table === null) throw new Error("nothing laid out");

    expect(bar.y).toBeGreaterThanOrEqual(outer.y - 1);
    expect(bar.y + bar.height).toBeLessThanOrEqual(outer.y + outer.height + 1);
    // Above the table rather than across its header.
    expect(bar.y + bar.height).toBeLessThanOrEqual(table.y + 1);
  });

  test("Bold reaches the cell with the caret rather than the note behind it", async ({ page }) => {
    /*
      Focus is in a widget's own `contenteditable`, so the document's selection
      is somewhere else entirely — this used to bold a word behind the table.
      A real chord and a real selection, because the offsets come from the
      browser's own selection API and jsdom's is a stub.
    */
    // A one-word cell, because a double-click selects a word and the browser
    // ends one at the hyphen in `0-inbox`.
    const cell = page.locator('[data-lp-row="0"][data-lp-column="2"]');
    await cell.dblclick();
    await page.keyboard.press("ControlOrMeta+b");

    await expect(cell).toHaveText("**me**");
    // Pressed again, the markers come off — the same toggle a paragraph gets.
    await page.keyboard.press("ControlOrMeta+b");
    await expect(cell).toHaveText("me");
  });

  test("the deletions arm once a cell has the caret, and act on that cell", async ({ page }) => {
    const remove = page.getByRole("button", { name: "Delete row" });
    await page.locator(GRID).first().locator("table").hover();
    await expect(remove).toBeDisabled();

    await page.locator('[data-lp-row="1"][data-lp-column="0"]').click();
    await expect(remove).toBeEnabled();
    await remove.click();

    // The row the caret was in is gone; the one above it stayed.
    const grid = page.locator(GRID).first();
    await expect(grid.locator("tbody tr")).toHaveCount(1);
    await expect(grid.locator("tbody tr td").first()).toHaveText("0-inbox");
  });
});
