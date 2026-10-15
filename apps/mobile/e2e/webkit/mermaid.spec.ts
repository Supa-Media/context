import { expect, test } from "@playwright/test";
import { goHome, tap, tapFolderOnHome, waitForNote } from "./helpers";

/**
 * A ```` ```mermaid ```` FENCE IS DRAWN AS A DIAGRAM, BY A FRAME THAT CANNOT
 * REACH THE CONSOLE.
 *
 * The half of `livePreview/diagram.ts` jsdom cannot test: that the frame page
 * the build puts beside the drawing editor loads, that its one script runs
 * inside `sandbox="allow-scripts"` under its own CSP (`script-src 'self'`
 * resolved from an opaque origin is the part worth proving in a real engine),
 * and that Mermaid draws the note's chart there.
 *
 * The fixture is the chart at the end of `2-areas/architecture-map.md` in
 * `placeholderData/seyi.ts`.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e-fixture");
  await page.getByTestId("note-scroll").waitFor();
  await goHome(page);
  await tapFolderOnHome(page, "areas");
  await tap(page, "architecture-map");
  await waitForNote(page, "Where the notes actually live");
});

test("the mermaid fence is drawn as a diagram", async ({ page }) => {
  const frame = page.locator("iframe.cm-lp-diagram-frame");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  const drawn = page.frameLocator("iframe.cm-lp-diagram-frame");
  await expect(drawn.locator("svg")).toBeVisible({ timeout: 15_000 });
  await expect(drawn.getByText("Your bucket")).toBeVisible();
  await expect(frame).toHaveClass(/cm-lp-diagram-drawn/);
  // Sized to what Mermaid drew, not left at zero or a guess.
  const box = await frame.boundingBox();
  expect(box!.height).toBeGreaterThan(30);
  // The fence's source is not on screen while the diagram is.
  await expect(page.locator(".cm-content")).not.toContainText("flowchart LR");
});

test("the frame cannot reach the console", async ({ page }) => {
  const drawn = page.frameLocator("iframe.cm-lp-diagram-frame");
  await expect(drawn.locator("svg")).toBeVisible({ timeout: 15_000 });
  const frame = await page.locator("iframe.cm-lp-diagram-frame").elementHandle();
  const content = await frame!.contentFrame();
  // An opaque origin: no storage, and no way into the parent's document.
  const reach = await content!.evaluate(() => {
    let parentDocument = "blocked";
    try {
      parentDocument = String(window.parent.document.title);
    } catch {
      /* the sandbox */
    }
    return { origin: window.origin, parentDocument };
  });
  expect(reach).toEqual({ origin: "null", parentDocument: "blocked" });
});

test("tapping the diagram gives the source back", async ({ page }) => {
  const frame = page.locator("iframe.cm-lp-diagram-frame");
  await expect(page.frameLocator("iframe.cm-lp-diagram-frame").locator("svg")).toBeVisible({ timeout: 15_000 });
  await frame.scrollIntoViewIfNeeded();
  const box = await frame.boundingBox();
  if (box === null) throw new Error("the diagram has no box to tap");
  /*
    The frame has `pointer-events: none`, so the tap reaches the editor and
    places the caret. Retried because the chart sits below the fold: a tap that
    lands while the scroll into view is still settling is taken as stopping the
    scroll, by the browser, before the editor ever sees it.
  */
  await expect(async () => {
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(frame).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(page.getByText("```mermaid").first()).toBeVisible();
});
