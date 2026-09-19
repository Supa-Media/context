import { expect, test } from "@playwright/test";
import { openWeeklyReview } from "./helpers";

/**
 * A CALLOUT, IN A REAL ENGINE, BECAUSE THE BUG WAS A PICTURE.
 *
 * `callouts.test.ts` proves the decisions against a real lezer tree with no
 * DOM: which blockquotes are callouts, what the marker covers, what survives to
 * the reader. What it cannot prove is the half the report actually was — a
 * screenshot of `!bible` underlined in blue in front of a reference, next to
 * the same note in Obsidian.
 *
 * jsdom lays nothing out and applies no stylesheet, so "the box is drawn" and
 * "the marker is gone from the screen" are claims only an engine can answer.
 * Both are asserted here against the same CodeMirror the console ships.
 */

test.beforeEach(async ({ page }) => {
  await openWeeklyReview(page);
});

/**
 * Type a callout at the end of the note, the way a person does.
 *
 * **The continuation lines carry no `>` of their own**, and finding that out is
 * why this helper exists. Pressing Enter inside a blockquote continues it —
 * the editor inserts the `> ` — so typing one as well produces `> > and the
 * door`, a nested quote inside the callout. The first run of this file did
 * exactly that and reported three boxed lines instead of two, which read as a
 * bug in the box and was a bug in the test.
 */
async function typeCallout(
  page: import("@playwright/test").Page,
  ...lines: readonly string[]
): Promise<void> {
  /*
    Focus the editor by tapping its FIRST LINE, not its middle.

    This used to tap the editor itself by its accessibility label — which
    `tap` resolves to the element's centre, and the centre of this note is the
    wikilink `placeholderData.ts` puts there. That was harmless while following
    a link took a long press; a tap now follows it, so the precondition of
    every test in this file navigated away from the note it was about and the
    callout was typed into a different one. The failure was honest and the
    feature was not at fault: a blunt "tap the editor" is not a way to place a
    caret in a document with links in it.

    The first line is the note's heading, which nothing can follow. Where the
    caret lands does not matter beyond that, because `Control+End` below moves
    it to the end regardless — only the focus is the precondition.
  */
  const first = page.locator(".cm-line").first();
  await expect(first).toBeVisible();
  const box = await first.boundingBox();
  if (box === null) throw new Error("the editor's first line has no box to tap");
  await page.touchscreen.tap(box.x + 6, box.y + box.height / 2);
  await page.keyboard.press("Control+End");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  for (const [index, line] of lines.entries()) {
    if (index > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(line, { delay: 8 });
  }
}

test("the callout marker never reaches the screen", async ({ page }) => {
  await typeCallout(page, "> [!bible] John 3:16 - NIV", "For God so loved the world.");
  // Off the line, so the reveal rule hides the marker — the same rule every
  // other mark in this editor follows.
  await page.keyboard.press("Control+Home");

  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("John 3:16 - NIV");
  await expect(editor).toContainText("For God so loved the world.");
  /*
    THE REPORT, INVERTED. That lone word in front of the reference is the whole
    of what looked wrong beside the Obsidian original.
  */
  await expect(editor).not.toContainText("!bible");
  await expect(editor).not.toContainText("[!");
});

test("the box is actually drawn, on every line of the callout", async ({ page }) => {
  await typeCallout(page, "> [!warning] Mind the gap", "and the door");
  await page.keyboard.press("Control+Home");

  const box = page.locator(".cm-lp-callout");
  await expect(box).toHaveCount(2);
  await expect(page.locator(".cm-lp-callout-head")).toHaveCount(1);

  /*
    Painted rather than merely classed. A class the stylesheet never reached
    would pass every assertion above and look exactly like the bug.
  */
  const drawn = await box.first().evaluate((node) => {
    const style = getComputedStyle(node);
    return { border: style.borderLeftWidth, background: style.backgroundColor };
  });
  expect(drawn.border).toBe("3px");
  expect(drawn.background).not.toBe("rgba(0, 0, 0, 0)");
});

test("an untitled callout is titled with its type, as Obsidian does", async ({ page }) => {
  await typeCallout(page, "> [!warning]", "Mind the gap");
  await page.keyboard.press("Control+Home");

  await expect(page.locator(".cm-lp-callout-type")).toHaveText("Warning");
});

test("the marker comes back the moment the caret is in it", async ({ page }) => {
  await typeCallout(page, "> [!warning] Mind the gap");
  const editor = page.locator(".cm-content");
  await expect(editor).not.toContainText("[!warning]");

  // Back onto the marker. Editing the type would be impossible otherwise.
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(editor).toContainText("[!warning]");
});
