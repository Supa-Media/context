import { expect, test, type Page } from "@playwright/test";

/**
 * The folding side panel, laid out by a real engine.
 *
 * **It used to be two**, and every case below that named the rail — its
 * column, its seam, its status toggle — is rewritten rather than deleted. The
 * rail folded into `SwitcherMenu` (`docs/decisions/app-and-console.md`), so
 * there is one left panel, one seam and one toggle; what those cases were
 * really holding is that a fold is *real layout* rather than a hidden panel
 * still holding its track, and that is asserted here of the panel that is
 * left.
 *
 * ## Why this file exists
 *
 * `__tests__/appFrameRender.test.ts` mounts the shipping frame and resolves
 * react-native-web's stylesheet, so it can assert that a region is drawn, that a
 * command is a no-op, and that a timer is cancelled. **jsdom lays nothing out**,
 * which is the class `docs/decisions/testing.md` puts in this directory — and
 * every claim the folding panels actually rest on is a layout claim:
 *
 *  - the peek **floats**: it must not push the editor across, because the
 *    paragraph somebody is reading would move under their eyes. That is the
 *    single reason it is absolutely positioned, and it is invisible to jsdom;
 *  - it lands **where the column was**, which is arithmetic on three tokens that
 *    type-checks whatever numbers it adds up;
 *  - folding the tree actually **gives the width to the editor**;
 *  - the seams are **hittable**, not zero-width slivers.
 *
 * `?screen=app-frame` mounts the real `AppFrame` with stub slots
 * (`features/e2e/AppFrameFixture.tsx`). Nothing here can reach an account or a
 * bucket; there is no data behind it. It is a separate fixture from
 * `E2EFixtureScreen`, which reproduces the console's panes and says in its own
 * header that what it does not reproduce is `AppFrame`.
 */

const FRAME = "/e2e-fixture?screen=app-frame";

/*
  **A pointer context, declared, because this file is the only one here that is
  not about a phone.**

  The config gives the whole suite 390×844 with `isMobile` and `hasTouch` set,
  which is right for every other spec in this directory and wrong for this one
  in a way that would not be obvious: resizing the viewport alone leaves touch
  emulation on, and hover on a surface the engine believes is a touchscreen is
  exactly the behaviour the peek depends on. Overriding the size and leaving the
  two flags would be a desktop-sized phone.
*/
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

/** The bounding box of a test id, failing loudly rather than returning null. */
async function box(page: Page, testId: string) {
  const found = await page.getByTestId(testId).boundingBox();
  if (found === null) throw new Error(`${testId} has no box`);
  return found;
}

test.beforeEach(async ({ page }) => {
  await page.goto(FRAME);
  // The editor, not the tree: `frame.ts` says the editor is the one region that
  // exists at every density — "there is no density with nothing to read" — and
  // waiting for the tree here hung the phone case, which correctly has none.
  await page.getByTestId("fixture-note").waitFor();
});

test("a desktop opens with the tree and the note beside it", async ({ page }) => {
  const tree = await box(page, "fixture-explorer");
  const note = await box(page, "fixture-note");

  // Left to right, not overlapping: the failure a column layout makes is
  // drawing one region on top of another, and it type-checks every time.
  expect(tree.x + tree.width).toBeLessThanOrEqual(note.x + 1);
  expect(note.width).toBeGreaterThan(700);

  // And the tree starts at the window's own edge, which is the whole of what
  // the fold bought: a 216pt rail used to stand here.
  expect(tree.x).toBeLessThan(4);
});

test("the tree's resizer is a target a pointer can actually hit", async ({ page }) => {
  // A seam that collapsed to zero width would still render, still pass every
  // jsdom assertion, and be unusable.
  const seam = await box(page, "explorer-resizer");
  expect(seam.width).toBeGreaterThanOrEqual(6);
  expect(seam.height).toBeGreaterThan(700);
});

test("folding the tree gives its width to the editor", async ({ page }) => {
  const before = await box(page, "fixture-note");

  await page.getByTestId("status-toggle-explorer").click();
  await expect(page.getByTestId("fixture-explorer")).toHaveCount(0);

  const after = await box(page, "fixture-note");
  // The column's width, less the seam that replaced it. If this came back equal
  // the fold would be cosmetic — a hidden panel still holding its track.
  expect(after.width).toBeGreaterThan(before.width + 200);
});

test("the peek floats: it lands where the column was and moves nothing", async ({ page }) => {
  const column = await box(page, "fixture-explorer");

  await page.getByTestId("status-toggle-explorer").click();
  await expect(page.getByTestId("fixture-explorer")).toHaveCount(0);
  const folded = await box(page, "fixture-note");

  await page.getByTestId("explorer-seam-closed").hover();
  await expect(page.getByTestId("explorer-peek")).toBeVisible();

  const peek = await box(page, "explorer-peek");
  const note = await box(page, "fixture-note");

  /*
    **The claim this file exists for.** The editor is exactly where it was with
    the tree folded — the peek is over it, not beside it. A flex sibling would
    pass every render test in the suite and shove the paragraph 260pt across the
    moment the pointer brushed the seam.
  */
  expect(note.x).toBe(folded.x);
  expect(note.width).toBe(folded.width);

  // And it arrives over the editor, at the width the column had.
  expect(peek.x).toBeGreaterThan(note.x - 1);
  // Within the column's own hairline: the fixture's slot is measured inside the
  // column's 1pt right border, and the floating panel has none.
  expect(Math.abs(peek.width - column.width)).toBeLessThanOrEqual(1);

  // The seam it was summoned from is still underneath it. If it were not, the
  // pointer resting on it would be resting on nothing.
  await expect(page.getByTestId("explorer-seam-closed")).toBeVisible();
});

test("the closed seam's chevron does not eat the press that opens it", async ({ page }) => {
  /*
    **The defect this fixture was built and immediately earned its keep on.**

    The chevron is 18pt wide on a 7pt or 10pt seam, because a chevron inside a
    hairline is unreadable — so it overhangs its own seam on both sides. As a
    plain child it sat on top of whatever was beside it: with the tree folded,
    the closed seam's chevron covered the rail's seam, and pressing the rail's
    seam re-opened the file tree instead. It is `pointerEvents="none"` now.

    The rail is gone and so is the seam the chevron was covering, so what is
    left to assert is the half that survives it: a drawing that took pointer
    events would take its own seam's press too. Hovered first, so the chevron
    is drawn at its full width rather than absent, and then the seam is pressed
    through it.

    jsdom has no pointers to intercept, so no render test could catch this, and
    it would ship as "the toggle sometimes does the wrong thing" — the kind of
    bug that gets reported as flakiness.
  */
  await page.getByTestId("status-toggle-explorer").click();
  await expect(page.getByTestId("explorer-seam-closed")).toBeVisible();

  await page.getByTestId("explorer-seam-closed").hover();
  await page.getByTestId("explorer-seam-closed").click({ timeout: 5000 });

  await expect(page.getByTestId("fixture-explorer")).toBeVisible();
});

test("the panel folded leaves the note nearly the whole window", async ({ page }) => {
  const before = await box(page, "fixture-note");

  // No chord here: the keymap is `console/_layout.tsx`'s and this fixture is the
  // frame alone. The status bar is the other half of the design and is the half
  // that has to work without one.
  await page.getByTestId("status-toggle-explorer").click();

  const after = await box(page, "fixture-note");
  expect(after.width).toBeGreaterThan(before.width + 200);

  // The instruments stay: the status bar is the way back, and a mode that hides
  // its own escape hatch is one people enter exactly once.
  await expect(page.getByTestId("status-toggle-explorer")).toBeVisible();

  await page.getByTestId("explorer-seam-closed").click();
  await expect(page.getByTestId("fixture-explorer")).toBeVisible();
});

test.describe("a phone", () => {
  // Back to the suite's own context, declared rather than resized into: the
  // claim here is about the surface with a thumb, which is what the two flags
  // are.
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("has no seam and no toggle", async ({ page }) => {
    // A phone has no left panel at all — navigation is the context strip and
    // the bottom row — so a seam offering to unfold one would be a control for
    // a region that does not exist.
    await expect(page.getByTestId("explorer-seam-closed")).toHaveCount(0);
    await expect(page.getByTestId("explorer-resizer")).toHaveCount(0);
    await expect(page.getByTestId("status-toggle-explorer")).toHaveCount(0);
    // The rail's own seam and toggle went with the rail, so these can no
    // longer be absent *at this density* — they are absent everywhere.
    await expect(page.getByTestId("rail-seam-toggle")).toHaveCount(0);
    await expect(page.getByTestId("status-toggle-rail")).toHaveCount(0);
    await expect(page.getByTestId("fixture-note")).toBeVisible();
  });
});
