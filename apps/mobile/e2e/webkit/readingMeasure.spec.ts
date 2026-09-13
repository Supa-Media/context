import { expect, test } from "@playwright/test";

/**
 * THE NOTE'S LINE LENGTH, MEASURED IN A REAL ENGINE AT BOTH WIDTHS.
 *
 * The rest of this suite exists because jsdom cannot run WebKit's event
 * pipeline. This file is here for a different gap in jsdom, and a more basic
 * one: **jsdom lays nothing out**, so no unit test in this repository can tell
 * a `max-width` that binds from a `max-width` that does not. Measured in
 * Chromium at 1440x900 before the fix, the element holding the first sentence
 * of the console's own demo note was 1160px wide with `max-width: none` on
 * every ancestor — roughly 150 characters to a line against the 60-75 that is
 * comfortable to read.
 *
 * It survived that long because the fixture note was hard-wrapped in
 * `placeholderData.ts`: the demo text broke at about fifty characters no
 * matter what the layout did, so every screenshot showed a tidy column. The
 * note is now written as normal unwrapped paragraphs, which is what makes the
 * measurement below mean anything.
 *
 * ## Characters, not pixels
 *
 * These assert the count of characters that land on a rendered line rather
 * than a pixel width, because the count is the constraint and the pixels are
 * whatever the font happens to be on the runner. The measure is set in `ch`
 * (`layout.readingMeasureCh`), which is the advance of "0" — wider than the
 * average lowercase letter, so 62ch of box holds something like 75 characters
 * of prose. That relationship is exactly the sort of arithmetic that should be
 * checked against a browser instead of trusted, which is what this does.
 *
 * ## What a chromium pass proves here
 *
 * Unlike the touch cases in `editor.spec.ts`, layout is not what this suite's
 * engine distinction is about: a measured column is CSS both engines
 * implement. Running under `--project=chromium` in a sandbox with no WebKit
 * binary is therefore a real check of this file — but it is still never
 * reported as a WebKit result. See `playwright.config.ts`.
 */

/**
 * Where the note's first body paragraph is, and how it broke.
 *
 * The measurements are taken off the **line box** — the leaf element holding
 * the sentence, which is what the original report measured at 1160px — rather
 * than off `.cm-content`. That is not incidental: `.cm-content` is deliberately
 * still the full width of the pane, and the column is cut out of it with
 * padding so that a click in the margin still reaches the editor. Measuring the
 * element that carries the constraint would prove nothing about the text.
 */
async function paragraph(page: import("@playwright/test").Page): Promise<{
  width: number;
  paneWidth: number;
  left: number;
  right: number;
  longestLine: number;
  lines: number;
}> {
  await page.goto("/e2e-fixture");
  // `1-projects/context-lc.md` is `SEYI_TREE.defaultSelection`, so the note
  // this measures is the one the console opens on with no navigation at all.
  const body = page.locator(".cm-line", { hasText: "Tenancy is bucket-level" }).first();
  await expect(body).toBeVisible();

  return await body.evaluate((line) => {
    const scroller = line.closest(".cm-scroller") as HTMLElement;

    /*
      How many characters actually land on each rendered visual line, walked
      one character at a time through a Range: the only way to ask the engine
      where it really broke the text. `.cm-line` is one Markdown line, which is
      now one whole paragraph.
    */
    const text = line.textContent ?? "";
    const node = line.firstChild;
    const lines: number[] = [];
    if (node !== null && node.nodeType === Node.TEXT_NODE) {
      const range = document.createRange();
      let top: number | null = null;
      let count = 0;
      for (let at = 0; at < text.length; at += 1) {
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        const box = range.getBoundingClientRect();
        if (top === null) top = box.top;
        if (Math.abs(box.top - top) > 1) {
          lines.push(count);
          top = box.top;
          count = 0;
        }
        count += 1;
      }
      lines.push(count);
    }

    const box = line.getBoundingClientRect();
    const pane = scroller.getBoundingClientRect();
    return {
      width: box.width,
      paneWidth: pane.width,
      left: box.left - pane.left,
      right: pane.right - box.right,
      longestLine: Math.max(...lines),
      lines: lines.length,
    };
  });
}

test.describe("at a desktop console width", () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test("a paragraph is a readable column, not the width of the pane", async ({ page }) => {
    const box = await paragraph(page);

    // The defect, stated as the thing that must not come back: the paragraph
    // filled the pane. It now takes a fraction of it.
    expect(box.width).toBeLessThan(box.paneWidth - 100);

    /*
      And the reason that matters, in the unit the constraint is really in.
      The design value is 62ch (`layout.readingMeasureCh`), which measured 75
      characters here and lands nearer 68 in a narrower face — the band these
      bounds sit around is 60-75.

      They are deliberately looser than that band, because how many characters
      fit in 62ch is a property of whatever font the runner resolved
      `system-ui` to, and this file must not go red because a CI image shipped
      a different sans. What it is for is the two failures that are not about
      fonts at all: the measure gone (about 150 characters, the defect), and a
      measure set to something nobody would read.
    */
    expect(box.longestLine).toBeGreaterThan(50);
    expect(box.longestLine).toBeLessThanOrEqual(85);

    // The paragraph really did wrap more than once — a one-line paragraph
    // would satisfy everything above while proving nothing.
    expect(box.lines).toBeGreaterThan(1);
  });

  test("the column is centred in the pane", async ({ page }) => {
    const box = await paragraph(page);
    // Within a point of equal, which is a centred column rather than a
    // left-aligned one with a ceiling on its width.
    expect(Math.abs(box.left - box.right)).toBeLessThan(2);
    // And there is real space either side to be centred in, so this is not
    // passing on a pane the column already fills.
    expect(box.left).toBeGreaterThan(60);
  });

  /**
   * THE EMPTY HALF OF THE PANE IS STILL THE EDITOR.
   *
   * The obvious way to draw a measured column is `max-width` plus auto
   * margins, and it looks identical. Measured in Chromium, it also leaves
   * `.cm-content` 572px wide inside a 1192px pane — so a click in the 310px
   * either side lands on `.cm-scroller`, the editor does not take focus, and
   * clicking beside a line to put the caret in it silently does nothing. Half
   * the note's apparent area would stop being the editing surface, which is a
   * worse bug than the one this change is fixing.
   *
   * `.cm-content` therefore stays the full width of the pane and the column is
   * cut out of it with padding. This is the test that stops the tidier-looking
   * recipe coming back.
   */
  test("clicking in the margin beside a line still puts the caret in the note", async ({ page }) => {
    const box = await paragraph(page);
    const line = await page
      .locator(".cm-line", { hasText: "Tenancy is bucket-level" })
      .first()
      .boundingBox();
    if (line === null) throw new Error("the paragraph has no box to click beside");

    // Well out into the right-hand margin, level with the first line of the
    // paragraph — empty space that belongs to no glyph.
    await page.mouse.click(line.x + line.width + box.right / 2, line.y + 8);

    await expect(page.locator(".cm-editor.cm-focused")).toHaveCount(1);
  });
});

test.describe("at the phone viewport", () => {
  /*
    The suite's own 390x844 — deliberately inherited rather than restated, so
    this tracks whatever `playwright.config.ts` calls "the phone".
  */
  test("the padding governs and the measure never binds", async ({ page }) => {
    const box = await paragraph(page);

    /*
      The whole width the scroller has, less its own gutters, is what the note
      gets: no centring, no slack, and in particular nothing lost to a measure
      that was set in pixels and happens to be narrower than the screen.
      The side padding here is the compact one — 390px is under
      `layout.narrowBreakpoint`, so the web console's own media query has
      already switched to reading type at 24px gutters — and the column is
      simply the pane minus both of them.
    */
    expect(box.width).toBe(box.paneWidth - box.left - box.right);
    expect(box.left).toBe(box.right);
    expect(box.left).toBeLessThan(30);
    expect(box.width).toBeGreaterThan(box.paneWidth - 60);
  });
});
