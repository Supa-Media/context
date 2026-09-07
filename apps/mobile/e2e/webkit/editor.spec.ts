import { expect, test } from "@playwright/test";
import { dispatchTouch, openWeeklyReview, tap } from "./helpers";

/**
 * The five cases `docs/decisions/testing.md` names as the ones an iOS-only
 * editor bug gets before its fix merges, run against a real browser engine
 * instead of jsdom simulating one. See that file and this directory's
 * `playwright.config.ts` for what a WebKit pass here proves and does not.
 *
 * All five open the same note — `2-areas/weekly-review.md` on the `@seyi`
 * fixture context, reached by `openWeeklyReview` exactly as a person would
 * reach it — because it is the one note carrying every construct these cases
 * need: a wikilink, a checked and an unchecked task, and a bullet long enough
 * to wrap. See `placeholderData.ts`'s comment on that note for why it, rather
 * than a note built for this suite alone.
 */

test.beforeEach(async ({ page }) => {
  await openWeeklyReview(page);
});

test("a long press on a wikilink raises the go-there prompt", async ({ page }) => {
  const link = page.locator(".cm-note-link").first();
  await expect(link).toBeVisible();
  const box = await link.boundingBox();
  if (box === null) throw new Error("the wikilink has no box to press");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  /*
    `noteLinks.ts`'s own sequence: touchstart, then — the finger not having
    moved — a touchcancel at 300ms, which is inside `LONG_PRESS_MS` (450ms) and
    past `PRESS_CANCEL_FLOOR_MS` (150ms). A cancel in that window is WebKit's
    long-press recogniser claiming the touch, and the handler leaves the timer
    running rather than treating it as an interruption. See `helpers.ts` for
    what dispatching it here proves and does not.
  */
  await dispatchTouch(page, "touchstart", point);
  await page.waitForTimeout(300);
  await dispatchTouch(page, "touchcancel", point);

  await expect(page.getByText("Open this note?")).toBeVisible();
});

test("a plain tap places the caret and does not navigate", async ({ page }) => {
  const link = page.locator(".cm-note-link").first();
  const before = await page.getByTestId("breadcrumb-leaf").textContent();

  const box = await link.boundingBox();
  if (box === null) throw new Error("the wikilink has no box to tap");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

  // No dialog, and the same note still open — a tap this quick has already
  // fired `touchend`, which cancels the pending long-press timer.
  await expect(page.getByText("Open this note?")).toHaveCount(0);
  await expect(page.getByTestId("breadcrumb-leaf")).toHaveText(before ?? "");

  // And the caret actually moved: CodeMirror gives the focused content
  // editable role the DOM selection, so the click is a real one rather than a
  // tap the editor silently dropped.
  const editor = page.getByRole("textbox");
  await expect(editor).toBeFocused();
});

test("the checkbox control toggles on tap", async ({ page }) => {
  const checkboxes = page.locator(".cm-lp-task");
  await expect(checkboxes).toHaveCount(2);
  const unchecked = page.locator('.cm-lp-task[aria-checked="false"]').first();
  await expect(unchecked).toHaveCount(1);

  const box = await unchecked.boundingBox();
  if (box === null) throw new Error("the unchecked task has no box to tap");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

  // Ticked, and — livePreview.ts turns this into three characters in the
  // buffer — nothing else on the line moved: the other task is still ticked,
  // there is still exactly one unchecked-then-checked round trip, not a
  // second widget appearing beside a stale one.
  await expect(page.locator('.cm-lp-task[aria-checked="false"]')).toHaveCount(0);
  await expect(page.locator('.cm-lp-task[aria-checked="true"]')).toHaveCount(2);
});

test("a list marker does not reveal under the caret", async ({ page }) => {
  // The plain bullet — not a task — carrying the long line issue #254 was
  // about. `BulletWidget`'s drawn glyph is `.cm-lp-bullet`; the raw markdown
  // it replaces is a literal "- " that must never come back onto the screen
  // just because the caret landed on that line.
  const bullets = page.locator(".cm-lp-bullet");
  const before = await bullets.count();
  expect(before).toBeGreaterThan(0);

  const line = page.getByText("Keep this list short", { exact: false });
  const box = await line.first().boundingBox();
  if (box === null) throw new Error("the long bullet line has no box to tap");
  // Near its start, where the marker sits and where issue #254 revealed it —
  // a tap in the middle of the line would not reach the regression this
  // guards.
  await page.touchscreen.tap(box.x + 2, box.y + box.height / 2);

  await expect(bullets).toHaveCount(before);
  await expect(page.getByText("- Keep this list", { exact: false })).toHaveCount(0);
});

test("the breadcrumb chip tap closes the note", async ({ page }) => {
  await expect(page.getByTestId("breadcrumb-leaf")).toBeVisible();

  await tap(page, "@seyi, the context you are in — open its root");

  // `deselect` — the fixture's stand-in for the real navigation's
  // `router.replace(browseHref(...))`, see `E2EFixtureScreen.tsx` — lands on
  // the context's own root: a folder listing, no leaf, no open note.
  await expect(page.getByTestId("breadcrumb-leaf")).toHaveCount(0);
  await expect(page.getByTestId("folder-row").first()).toBeVisible();
});
