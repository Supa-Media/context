import { expect, test } from "@playwright/test";
import { dispatchTouch, openWeeklyReview, tap } from "./helpers";

/**
 * The five cases `docs/decisions/testing.md` names as the ones an iOS-only
 * editor bug gets before its fix merges, run against a real browser engine
 * instead of jsdom simulating one. See that file and this directory's
 * `playwright.config.ts` for what a WebKit pass here proves and does not.
 *
 * All of them open the same note — `2-areas/weekly-review.md` on the `@seyi`
 * fixture context, reached by `openWeeklyReview` exactly as a person would
 * reach it — because it is the one note carrying every construct these cases
 * need: a wikilink, a checked and an unchecked task, and a bullet long enough
 * to wrap. See `placeholderData.ts`'s comment on that note for why it, rather
 * than a note built for this suite alone.
 */

test.beforeEach(async ({ page }) => {
  await openWeeklyReview(page);
});

test("a tap on a wikilink follows it", async ({ page }) => {
  /*
    The gesture this suite was written for, inverted — and the inversion is
    the feature. A long press used to be how a link was followed here, behind
    an "Open this note?" confirmation, because a press is also how a selection
    starts. Getting that press to arrive at all took `noteLinks.ts`'s whole
    `touchcancel`/`contextmenu` reading of WebKit's own recogniser. A tap is
    over before any recogniser has an opinion, and it is not ambiguous.
  */
  const link = page.locator(".cm-note-link").first();
  await expect(link).toBeVisible();
  const box = await link.boundingBox();
  if (box === null) throw new Error("the wikilink has no box to tap");
  const before = await page.getByTestId("breadcrumb-leaf").textContent();

  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

  // The note it names is open: the breadcrumb's leaf is the one thing on this
  // screen that says which note that is once the document has scrolled.
  await expect(page.getByTestId("breadcrumb-leaf")).not.toHaveText(before ?? "");
  // And nothing asks first. The confirmation is gone with the press.
  await expect(page.getByText("Open this note?")).toHaveCount(0);
});

test("a long press does not navigate — it is a selection again", async ({ page }) => {
  /*
    The control, and the case that used to be the feature. Driven as
    `noteLinks.ts`'s old sequence drove it: touchstart, the finger not moving,
    then WebKit's own `touchcancel` at 300ms. That window used to *be* the
    press — the handler left its timer running through the cancel precisely
    because a cancel over a stationary finger was the recogniser claiming the
    touch. Nothing reads it that way now.

    See `helpers.ts` for what dispatching this here proves and does not.
  */
  const link = page.locator(".cm-note-link").first();
  await expect(link).toBeVisible();
  const box = await link.boundingBox();
  if (box === null) throw new Error("the wikilink has no box to press");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = await page.getByTestId("breadcrumb-leaf").textContent();

  await dispatchTouch(page, "touchstart", point);
  await page.waitForTimeout(300);
  await dispatchTouch(page, "touchcancel", point);
  await page.waitForTimeout(400);

  await expect(page.getByText("Open this note?")).toHaveCount(0);
  await expect(page.getByTestId("breadcrumb-leaf")).toHaveText(before ?? "");
});

test("a tap that drifts is a scroll, not a follow", async ({ page }) => {
  /*
    A note is a scroller and most notes have links in them, so a tap that
    survived a drag would navigate on an ordinary flick down the page. This is
    the one case in this file that `editorLinks.test.ts` also covers, and it is
    here because the slop is measured in real CSS pixels against a real layout
    rather than at jsdom's position 0.
  */
  const link = page.locator(".cm-note-link").first();
  await expect(link).toBeVisible();
  const box = await link.boundingBox();
  if (box === null) throw new Error("the wikilink has no box to drag from");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = await page.getByTestId("breadcrumb-leaf").textContent();

  await dispatchTouch(page, "touchstart", point);
  await dispatchTouch(page, "touchmove", { x: point.x, y: point.y + 60 });
  await dispatchTouch(page, "touchend", { x: point.x, y: point.y + 60 });

  await expect(page.getByTestId("breadcrumb-leaf")).toHaveText(before ?? "");
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
