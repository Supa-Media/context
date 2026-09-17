import { expect, test } from "@playwright/test";

/**
 * Formatting a note with a pointer, in a real browser.
 *
 * `editorContextMenu.test.ts` drives this whole feature under jsdom and gets
 * most of the way there. What it cannot do is the part this file exists for:
 * **jsdom lays nothing out**, so `posAtCoords` there either throws or maps
 * every point to the end of the document, and the jsdom suite has to stub it.
 * That stub is honest about what it is — but it means the one question a
 * right-click menu has to get right, *where did the pointer land*, is answered
 * by the test rather than by the editor. Only a real engine can answer it.
 *
 * Two more things only a laid-out document has: a menu that is actually on
 * screen at the pointer rather than merely present in the DOM, and a real text
 * selection made by dragging.
 *
 * ## This block is the one desktop viewport in the suite, deliberately
 *
 * Everything else here runs at 390×844 with touch, because the bugs the suite
 * was built for are iOS bugs. A right-click is not something a phone has, and
 * `Menu.web.tsx` draws a bottom sheet rather than a popover below
 * `layout.narrowBreakpoint` — so a phone viewport would test the sheet under a
 * gesture the sheet never receives. The override says pointer, no touch, wide
 * enough for the popover.
 */
test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

/**
 * The fixture's own default note, open on arrival.
 *
 * `openWeeklyReview` walks the phone's tree — a folder view, a breadcrumb, a
 * `note-scroll` — none of which exist at this width, where the console draws a
 * rail, an explorer and the editor side by side. Nothing here needs a
 * particular note's constructs the way the touch specs do; it needs prose with
 * a word in it, which `1-projects/context-lc.md` (`placeholderData.ts`'s
 * `defaultSelection`) is.
 */
test.beforeEach(async ({ page }) => {
  await page.goto("/e2e-fixture");
  await page.locator(".cm-content").waitFor();
  await expect(page.locator(".cm-content")).toContainText("Tenancy");
});

/**
 * Double-click the first word of the line carrying `text`, and say where.
 *
 * At a point rather than through `getByText`: Live Preview draws a line as a
 * run of spans, so a text locator resolves to the whole line and a `dblclick`
 * on it lands in the middle — selecting whichever word happens to sit at the
 * centre of the paragraph. Measured, that was `workspace` rather than the word
 * the test named, and the assertion passed on nothing. A few pixels in from the
 * line's own left edge is the first word, whatever the layout does.
 *
 * The point comes back because the right-click that follows has to land
 * *inside* the selection — that is the case where the handler leaves it alone,
 * and it is what every menu row then acts on.
 */
async function selectFirstWord(
  page: import("@playwright/test").Page,
  text: string,
): Promise<{ x: number; y: number }> {
  const line = page.locator(".cm-line", { hasText: text }).first();
  await line.waitFor();
  const box = await line.boundingBox();
  if (box === null) throw new Error(`the line carrying "${text}" has no box`);
  /*
    Near the *top* of the box, not its middle. `EditorView.lineWrapping` is on,
    so one `.cm-line` is several visual rows and its box spans all of them —
    measured, the centre of this paragraph is the word `customer`, three rows
    down, which is a test that selects something and then asserts about
    something else.
  */
  const point = { x: box.x + 12, y: box.y + 10 };
  await page.mouse.dblclick(point.x, point.y);
  return point;
}

test("a right-click over the note opens the formatting menu at the pointer", async ({ page }) => {
  const content = page.locator(".cm-content");
  const box = await content.boundingBox();
  if (box === null) throw new Error("the editor has no box to click");
  const point = { x: box.x + 60, y: box.y + 24 };

  await page.mouse.click(point.x, point.y, { button: "right" });

  const bold = page.getByTestId("menu-item-bold");
  await expect(bold).toBeVisible();

  // At the pointer, not in a corner. `place` flips rather than clips, and this
  // click is nowhere near an edge, so the box's own corner is the point.
  const menu = await page.getByTestId("menu-root").boundingBox();
  if (menu === null) throw new Error("the menu is not laid out");
  expect(Math.abs(menu.x - point.x)).toBeLessThan(2);
  expect(Math.abs(menu.y - point.y)).toBeLessThan(2);
});

test("and Bold wraps the word that was actually selected", async ({ page }) => {
  const point = await selectFirstWord(page, "Tenancy is bucket-level");
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toBe("Tenancy");

  // Right-click inside the selection keeps it — the one case the handler does
  // not move the caret for.
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(page.getByTestId("menu-item-copy")).toBeVisible();
  await page.getByTestId("menu-item-bold").click();

  await expect(page.locator(".cm-content")).toContainText("**Tenancy**");
});

/**
 * ⌘B against a real key event, a real selection and a real `EditorView`.
 *
 * **What this cannot say anything about is the rail.** ⌘B is `toggleRail` in
 * `keymap.ts` and bold only inside a note, and the two are kept apart by scope
 * precedence plus `useKeymap.web.ts` ignoring a keystroke the editor already
 * answered. Neither is exercised here: `/e2e-fixture` mounts `FixtureScreen`,
 * not the console layout, so the app's keyboard layer is not on this page at
 * all — measured, ⌘B with the caret outside the editor moves nothing. That half
 * is proved in `keymap.test.ts` and `useKeymapWeb.test.ts`, both sabotaged.
 * What is proved here is the other half: the chord reaches the editor through a
 * real browser and bolds what is really selected.
 */
test("⌘B bolds the selection", async ({ page }) => {
  await selectFirstWord(page, "Tenancy is bucket-level");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.locator(".cm-content")).toContainText("**Tenancy**");

  // And again takes it off, which is the press this whole change is about and
  // the one jsdom's selection model made hardest to trust.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.locator(".cm-content")).not.toContainText("**Tenancy**");
  await expect(page.locator(".cm-content")).toContainText("Tenancy is bucket-level");
});

/**
 * A NOTE NOBODY HAS TOUCHED DRAWS NO MARKUP, AND A MENU COMMAND IS TOUCHING IT.
 *
 * Live Preview hides markup away from the caret, and a caret exists the moment
 * the document does — so a note that was merely *opened* used to draw the
 * markup of whichever construct `openingCaret` happened to land in, which is
 * the first line of the writing and on most notes a `# Title`. The gate that
 * fixed that is `editorEngaged` in `livePreview.ts`.
 *
 * This is the case that decided what the gate reads, and it belongs in a real
 * browser because nothing else can produce the event sequence. Written first as
 * DOM focus, it broke Bold-from-the-menu and did it invisibly: the popover
 * blurs the editor, `runMenuAction` calls `view.focus()` straight back,
 * `document.activeElement` really is `.cm-content`, and a blur transaction
 * still arrives last — so the `**` went in and rendered hidden, and Bold looked
 * like a no-op. The Bold cases above catch that, and this one says what is
 * actually being claimed on either side of it.
 */
test("the note opens clean, and the first click is what brings its markup back", async ({
  page,
}) => {
  const content = page.locator(".cm-content");
  /*
    `1-projects/context-lc.md` opens on a `# ` heading and `openingCaret` puts
    the caret on that line, which is exactly the position that used to reveal
    it. The title is drawn, the hash is not.
  */
  await expect(content).toContainText("Context.LC — build decisions");
  await expect(content).not.toContainText("# Context.LC");

  // A click in the text is somebody working here, and the line they are on
  // shows what it is made of.
  const heading = page.locator(".cm-line", { hasText: "Context.LC — build decisions" }).first();
  await heading.click();
  await expect(content).toContainText("# Context.LC");
});

test("Table… hands over a grid, and a cell writes a table of that size", async ({ page }) => {
  const box = await page.locator(".cm-content").boundingBox();
  if (box === null) throw new Error("the editor has no box to click");
  await page.mouse.click(box.x + 60, box.y + 24, { button: "right" });

  await page.getByTestId("menu-item-table").click();
  await expect(page.getByTestId("table-size-picker")).toBeVisible();

  // Hovering is the whole gesture, and it is the half jsdom cannot do: the
  // caption is the only feedback the rectangle gives.
  await page.getByTestId("table-size-3x2").hover();
  await expect(page.getByTestId("table-size-caption")).toHaveText("3 × 2");

  await page.getByTestId("table-size-3x2").click();
  await expect(page.getByTestId("table-size-picker")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("| --- | --- | --- |");
});
