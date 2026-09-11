import { expect, test } from "@playwright/test";
import { tap } from "./helpers";

/**
 * A DIAGRAM THAT LIVES IN A NOTE, DRAWN BY A FRAME THAT CANNOT RUN CODE.
 *
 * This is the half of the `html-preview` feature that jsdom cannot test, and
 * the reason is not a gap in the fixture: **jsdom does not enforce iframe
 * sandboxing at all** — it does not load `srcdoc`, and it has no notion of a
 * frame being denied script execution. A jsdom test asserting "the note's
 * `<script>` did not run" would pass with `allow-scripts` set on the frame, and
 * would be a false green of exactly the class this repository keeps producing.
 * `__tests__/htmlPreviewFrame.test.ts` asserts on the attribute; only a real
 * engine can say what the attribute *does*.
 *
 * The fixture note is `2-areas/architecture-map.md` in `placeholderData.ts`.
 * Its preview fence opens with `<script>window.PWNED = 1</script>`, which is
 * what a note emailed in by a stranger looks like — anyone can write to
 * `<name>@context.lc`, and that is the ingestion design rather than a gap in
 * it.
 *
 * Two of these cases are measurements rather than assertions about markup, for
 * the reason `first-run.spec.ts` states: **two layout defects shipped past a
 * fully green jsdom suite in the Premium work**, and a frame drawing over the
 * console's own chrome is the same class of failure.
 *
 * See `playwright.config.ts` for what a `chromium` run of this proves and does
 * not; a pass there is never reported as a WebKit result.
 */

/** From the fixture's landing note to the note carrying the diagram. */
async function openArchitectureMap(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/e2e-fixture");
  await page.getByTestId("note-scroll").waitFor();
  await tap(page, "@seyi, the context you are in — open its root");
  await page.getByTestId("folder-row").first().waitFor();
  await tap(page, "2-areas, folder");
  await tap(page, "architecture-map");
  await page.getByTestId("breadcrumb-leaf").waitFor();
}

test.beforeEach(async ({ page }) => {
  await openArchitectureMap(page);
});

/**
 * The acceptance case: the fence is drawn as the thing it describes.
 *
 * Asserted through the frame's *content* rather than just the element, because
 * an iframe that failed to parse its `srcdoc` is still an iframe of the right
 * size in the right place. `frameLocator` reaches in exactly as far as
 * Playwright's driver does — the page itself cannot, which is the point.
 */
test("the preview fence renders as a diagram", async ({ page }) => {
  const frame = page.locator("iframe.cm-lp-preview-frame");
  await expect(frame).toHaveCount(1);
  await expect(frame).toBeVisible();

  const drawn = page.frameLocator("iframe.cm-lp-preview-frame").locator(".zmap");
  await expect(drawn).toBeVisible();
  // The three zone boxes and the amber rail beside them, which is what makes
  // it this diagram rather than three rectangles.
  await expect(page.frameLocator("iframe.cm-lp-preview-frame").locator(".bd")).toHaveCount(3);
  await expect(page.frameLocator("iframe.cm-lp-preview-frame").locator(".rail .br")).toBeVisible();
});

/**
 * THE ONE THAT MATTERS. A script in the fence does not execute.
 *
 * `window.PWNED` is read twice: on the host page, where it would land if the
 * frame could reach out of its own origin at all, and inside the frame, which
 * is where a script that merely *ran* would set it. Both after the diagram has
 * demonstrably rendered, so this cannot pass because nothing loaded yet.
 *
 * ## What the sabotage run actually showed, because it is not what was expected
 *
 * Run against Chromium with each guard broken in turn, and worth writing down
 * rather than restating the intent:
 *
 *  - **`sandbox=""` → `sandbox="allow-scripts"`, CSP untouched: this case
 *    stayed green.** The `default-src 'none'` on the frame's document has no
 *    `script-src` beside it, so CSP refuses the inline script on its own.
 *  - **CSP opened with `script-src 'unsafe-inline'`, `sandbox` left bare: also
 *    green.** The sandbox refuses it on its own. That is the claim the feature
 *    rests on, and it is now measured rather than assumed.
 *  - **Both broken together: RED**, on the in-frame read. So this case is not
 *    vacuous — it detects a script that genuinely ran.
 *
 * The honest reading is that there are two mechanisms here and either one is
 * sufficient, which is why the test above it asserts the attribute directly and
 * the jsdom suite asserts the CSP directly: each guard has a case that fails
 * when *it* is removed, rather than one case that passes as long as either
 * survives. The CSP is not the "second mechanism nobody tests" the brief warns
 * against — it is there for `background:url(https://…)`, which needs no script
 * at all and is a read receipt on a note you did not ask for. Blocking script
 * is a side effect of `default-src 'none'`, not the reason for it.
 */
test("a script inside the fence does not run", async ({ page }) => {
  await expect(
    page.frameLocator("iframe.cm-lp-preview-frame").locator(".zmap"),
  ).toBeVisible();

  expect(await page.evaluate(() => (window as unknown as { PWNED?: unknown }).PWNED)).toBeUndefined();

  // And nothing ran inside the frame either: `document.title` is what the
  // script would have had to be able to touch first.
  const inside = await page
    .frameLocator("iframe.cm-lp-preview-frame")
    .locator("body")
    .evaluate((body) => (body.ownerDocument.defaultView as unknown as { PWNED?: unknown }).PWNED);
  expect(inside).toBeUndefined();
});

/**
 * The attribute, read off the live DOM rather than off the module that built
 * it. Sabotage-tested: adding either token turns this red.
 */
test("the frame's sandbox is bare in the shipped page", async ({ page }) => {
  const sandbox = await page.locator("iframe.cm-lp-preview-frame").getAttribute("sandbox");
  expect(sandbox).toBe("");
  expect(sandbox ?? "").not.toContain("allow-scripts");
  expect(sandbox ?? "").not.toContain("allow-same-origin");
});

/**
 * Opting in is the whole convention, checked in the place it actually matters:
 * the same note carries a plain ```` ```html ```` fence, and it is still a code
 * block. One iframe on the page, not two.
 */
test("a plain html fence in the same note stays a code block", async ({ page }) => {
  await expect(page.locator("iframe.cm-lp-preview-frame")).toHaveCount(1);
  await expect(page.getByText("quoted, never drawn")).toBeVisible();
});

/**
 * `livePreview.ts`'s central rule, which that file argues for at length: you
 * cannot edit syntax you cannot see. A tap on the diagram puts the caret in the
 * block and the raw fence comes back — which only works because the frame
 * carries `pointer-events: none` and the click reaches the editor underneath.
 */
test("tapping the diagram gives the raw fence back", async ({ page }) => {
  const frame = page.locator("iframe.cm-lp-preview-frame");
  const box = await frame.boundingBox();
  if (box === null) throw new Error("the preview has no box to tap");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

  await expect(frame).toHaveCount(0);
  await expect(page.getByText("```html-preview").first()).toBeVisible();

  /*
    And it draws again when the caret leaves — in the *same* editor, by moving
    the caret rather than by reopening the note. Reopening would prove only
    that a fresh editor renders, which the first case already proves; a reveal
    that never closes is a fence you can look at exactly once, and only a
    second caret move inside one session can catch that.
  */
  /*
    Scoped inside the editor rather than to the page: the note's title is also
    the breadcrumb's leaf, and a bare `getByText(...).first()` tapped the
    breadcrumb — which moves no caret, so the fence stayed revealed and this
    case failed for a reason that had nothing to do with the feature.
  */
  const line = page.getByRole("textbox").locator(".cm-line").first();
  const lineBox = await line.boundingBox();
  if (lineBox === null) throw new Error("the note's first line has no box to tap");
  await page.touchscreen.tap(lineBox.x + 6, lineBox.y + lineBox.height / 2);

  await expect(page.locator("iframe.cm-lp-preview-frame")).toHaveCount(1);
  await expect(
    page.frameLocator("iframe.cm-lp-preview-frame").locator(".zmap"),
  ).toBeVisible();
});

/**
 * THE FRAME CANNOT DRAW OUTSIDE ITS BOX.
 *
 * Measured, not asserted from CSS: the markup came from a stranger, and a
 * layout that escapes its container draws over real console UI — the
 * breadcrumb, the save state, a privacy control. `overflow: hidden` on the
 * wrapper is what holds it, and only a browser can say whether it did.
 */
test("the preview stays inside the note's own column", async ({ page }) => {
  const frame = (await page.locator("iframe.cm-lp-preview-frame").boundingBox())!;
  const scroller = (await page.locator(".cm-lp-root .cm-scroller").boundingBox())!;

  expect(frame.x).toBeGreaterThanOrEqual(scroller.x - 1);
  expect(frame.x + frame.width).toBeLessThanOrEqual(scroller.x + scroller.width + 1);

  // Nothing under it was covered: the breadcrumb is above the editor and must
  // still be where it was, not behind a diagram that grew past its clip.
  const crumb = (await page.getByTestId("breadcrumb-leaf").boundingBox())!;
  expect(crumb.y + crumb.height).toBeLessThanOrEqual(frame.y + 1);

  // The page does not scroll sideways, which is what a box that escaped
  // horizontally would cause even if it drew nothing visible.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
