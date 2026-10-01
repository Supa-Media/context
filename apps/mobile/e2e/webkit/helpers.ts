import type { Locator, Page } from "@playwright/test";

/**
 * Real touch, everywhere a plain tap or a hold is enough.
 *
 * `page.touchscreen.tap` dispatches a real `touchstart`/`touchend` pair
 * through the browser engine's own input pipeline — in WebKit as much as in
 * Chromium — which is the whole reason this suite exists rather than driving
 * `click()`. `getByLabel` finds the row by the `accessibilityLabel`
 * `FolderView.tsx`/`ContextStrip.tsx` already set; react-native-web renders it
 * as `aria-label`.
 */
export async function tap(page: Page, label: string): Promise<void> {
  const box = await page.getByLabel(label, { exact: true }).boundingBox();
  if (box === null) throw new Error(`no element labelled "${label}" to tap`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Where `target` is once it has stopped moving. A phone's page slides in
 * (`PageSlide`), so a box read mid-slide is a tap on whatever slides under it.
 */
export async function settledBox(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await target.waitFor();
  let box = await target.boundingBox();
  for (let tries = 0; tries < 20; tries++) {
    await target.page().waitForTimeout(50);
    const next = await target.boundingBox();
    const still = box !== null && next !== null && box.x === next.x && box.y === next.y;
    box = next;
    if (still) break;
  }
  if (box === null) throw new Error("nothing to tap");
  return box;
}

/**
 * Back to Home the way a person on a phone gets there: the top-left ‹ until
 * there is no page above to go back to. The path row this used to tap is gone
 * (2026-10-01), and each press goes up one folder, as Apple Notes' does.
 */
export async function goHome(page: Page): Promise<void> {
  const back = page.getByTestId("phone-back");
  for (let i = 0; i < 6 && (await back.count()) > 0; i += 1) {
    const box = await back.boundingBox();
    if (box === null) break;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(350);
  }
  await page.getByTestId("phone-home").waitFor();
}

/**
 * Wait until the open note is the one whose text includes `heading`. The
 * phone draws no path row naming the note any more; its own first line does.
 */
export async function waitForNote(page: Page, heading: string): Promise<void> {
  await page.locator(".cm-content").filter({ hasText: heading }).first().waitFor();
}

/** Tap one of Home's folder lines by the folder's name, whatever it holds. */
export async function tapFolderOnHome(page: Page, name: string): Promise<void> {
  const line = page.getByTestId("phone-home-folder").filter({ has: page.getByText(name, { exact: true }) });
  await line.first().waitFor();
  const box = await line.first().boundingBox();
  if (box === null) throw new Error(`no folder "${name}" on Home to tap`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Tap a row of a phone's folder page by the name it shows, whatever its
 * count, date or first line says beside it (board 07 puts those in the row's
 * accessible name too, the way Home's lines carry their counts).
 */
export async function tapRow(page: Page, name: string): Promise<void> {
  const row = page.getByTestId("folder-row").filter({ has: page.getByText(name, { exact: true }) });
  await row.first().waitFor();
  const box = await row.first().boundingBox();
  if (box === null) throw new Error(`no row "${name}" to tap`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * From the fixture's landing note to `2-areas/weekly-review.md` — the note
 * `placeholderData.ts` carries the wikilink, the two tasks and the long
 * bullet on. Pressing through the real tree is what a person does, and it
 * exercises Home, the folder view and the note in one pass rather
 * than needing the fixture to pre-select a note no navigation reached.
 */
export async function openWeeklyReview(page: Page): Promise<void> {
  await page.goto("/e2e-fixture");
  // The note that opens by default (`1-projects/context-lc.md`, see
  // `placeholderData.ts`'s `SEYI_TREE.defaultSelection`) has to be on screen
  // before anything else is pressed — otherwise a slow first paint races the
  // rest of this walk.
  await page.getByTestId("note-scroll").waitFor();
  await goHome(page);
  // The root on a phone is Home (2026-09-30): every top-level folder is one
  // line there, named with what it holds.
  await tapFolderOnHome(page, "areas");
  await page.getByTestId("folder-row").first().waitFor();
  await tap(page, "weekly-review");
  await waitForNote(page, "Weekly review");
}

/**
 * One real `TouchEvent` at a page coordinate, dispatched at the element
 * actually there — never at whatever was cached before the tree re-rendered.
 *
 * This is the one place the suite steps outside `page.touchscreen`, and the
 * reason is a gap in Playwright's own API rather than a shortcut: `Touchscreen`
 * has exactly one method, `tap(x, y)` — an instant `touchstart` plus
 * `touchend`, with no way to hold a finger down, move it, or have the browser
 * cancel it, in either engine. There is no public, cross-browser way to ask a
 * real OS input pipeline for a *held* touch. So case (a) — the long press
 * WebKit answers with its own `touchcancel` rather than a `touchend`, per
 * `noteLinks.ts`'s header — is driven by constructing that `TouchEvent`
 * directly and dispatching it on the element under the point, which is
 * processed by the page's real listeners exactly as a browser-generated one
 * would be.
 *
 * **What this proves and what it does not**, stated once here rather than at
 * each call site: it proves the app's own long-press/`touchcancel` handling
 * runs correctly inside a genuine WebKit JavaScript engine and DOM — a
 * different engine from the Chromium `noteLinks.test.ts` already exercises
 * this sequence against. It does **not** reproduce WebKit's *native* long-press
 * gesture recognizer actually deciding to claim the touch and raise
 * `touchcancel` on its own initiative; that recognizer runs beneath any
 * JavaScript this page could dispatch, in Playwright or otherwise. See
 * `docs/decisions/testing.md`.
 */
export async function dispatchTouch(
  page: Page,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  point: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    ({ type, x, y }) => {
      const target = document.elementFromPoint(x, y);
      if (target === null) throw new Error(`nothing at (${x}, ${y}) to dispatch ${type} on`);
      const live = type === "touchstart" || type === "touchmove";
      const init = { identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y };
      /*
        Measured live in this repository's own WebKit CI run: `new Touch(init)`
        throws `TypeError: Illegal constructor` there, while the exact same
        call is fine in Chromium — WebKit accepts real touches from its own
        input pipeline (every `page.touchscreen.tap` in this suite proves
        that) but does not expose `Touch` as constructible from page script in
        this build. A plain object shaped like a `Touch` is what every
        cross-browser touch-simulation polyfill falls back to for exactly this
        engine, and `TouchEvent`'s `touches`/`changedTouches` only ever read
        the properties off each entry rather than requiring `instanceof
        Touch`. `TouchEvent` itself is guarded the same way on the chance a
        future WebKit build narrows that too.
      */
      let touch: unknown = init;
      if (typeof Touch === "function") {
        try {
          touch = new Touch(init);
        } catch {
          touch = init;
        }
      }
      const eventInit = {
        bubbles: true,
        cancelable: true,
        touches: live ? [touch] : [],
        targetTouches: live ? [touch] : [],
        changedTouches: [touch],
      };
      let event: Event;
      try {
        event = new TouchEvent(type, eventInit as TouchEventInit);
      } catch {
        // `Object.assign` was the first version of this fallback and it threw
        // its own error, measured live in the same WebKit run: "Attempted to
        // assign to readonly property" — `bubbles`/`cancelable` are read-only
        // accessors on `Event.prototype`, and `Object.assign` writes through
        // to whatever the property already resolves to rather than shadowing
        // it. `bubbles`/`cancelable` go through `CustomEvent`'s own
        // constructor instead, and `defineProperty` creates a genuine OWN
        // property for the three touch-list fields — which shadows an
        // inherited accessor rather than trying to write through it, so this
        // cannot repeat that failure whatever else `CustomEvent.prototype`
        // turns out to define.
        event = new CustomEvent(type, { bubbles: true, cancelable: true });
        for (const key of ["touches", "targetTouches", "changedTouches"] as const) {
          Object.defineProperty(event, key, { value: eventInit[key], configurable: true });
        }
      }
      target.dispatchEvent(event);
    },
    { type, x: point.x, y: point.y },
  );
}
