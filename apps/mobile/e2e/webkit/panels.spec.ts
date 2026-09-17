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

test.describe("dragging the seam", () => {
  /*
    **A different fixture, and the reason is the bug.** Everything above runs
    against `?screen=app-frame`, whose slots are stubs — which is right for
    geometry and useless here: the defect is the browser deciding that a drag
    across the tree is a *text selection*, and a stub slot holding the words
    "1-projects" has almost no text to select. `?screen=app-frame-visual` puts
    the real `Explorer` on fixture data in the same real frame, so the pointer
    crosses note names the way a hand does. The `beforeEach` below navigates
    away from the one the file opens with, which is the whole of what these
    cases take from the describe around them — the desktop pointer context at
    the top of the file is the other half, and it is the half that matters.
  */
  test.beforeEach(async ({ page }) => {
    await page.goto("/e2e-fixture?screen=app-frame-visual");
    await page.getByTestId("explorer-resizer").waitFor();
  });

  /** Where the seam is, which is where the column's edge is. */
  const seamX = async (page: Page) => (await box(page, "explorer-resizer")).x;

  /**
   * Drag the seam by `by` points in three moves, answering with where the seam
   * ended up after each one.
   *
   * Three moves rather than one, interpolated rather than teleported: the first
   * is what makes the browser start selecting and the rest are what the
   * selection used to kill. A single jump would be one event, and would pass
   * against the bug.
   */
  async function dragSeam(page: Page, by: number) {
    const seam = await box(page, "explorer-resizer");
    const x = seam.x + seam.width / 2;
    /*
      Beside the list's rows rather than at the seam's midpoint, which is level
      with the empty space below the last note. It is the difference between
      reproducing this and not: what kills the gesture is the pointer crossing a
      *name*, and measured against the bundle before the fix, a pull at this
      height moved the seam 3pt and a pull at the midpoint moved the whole 45.
    */
    const y = seam.y + 200;
    const seen: number[] = [];

    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const step of [1, 2, 3]) {
      await page.mouse.move(x + (by * step) / 3, y, { steps: 6 });
      seen.push(await seamX(page));
    }
    await page.mouse.up();
    return seen;
  }

  test("the seam drags left as far as it drags right", async ({ page }) => {
    /*
      **The direction that did not work, and the reason no unit test could have
      told us.**

      A pointer moving with the button down is a text selection as far as the
      browser is concerned, and react-native-web's responder system terminates
      the gesture the moment one becomes valid. Dragging left crosses the tree's
      note names, so the drag died about three points in and the column stopped
      under the pointer; dragging right crosses the note, where a selection
      begun outside the editing host does not extend. What was left was a handle
      that answered only to a pull slow enough to stay inside its own 7pt strip,
      which is the one place on that side with no text in it.

      Measured against the shipping bundle before the fix: a 45pt pull left
      moved the seam 3pt and then froze.
    */
    const start = await seamX(page);

    const narrowing = await dragSeam(page, -45);
    /*
      Loose by a few points rather than exact, and the slack is real: a
      `PanResponder` accumulates its delta per move event, and two of
      Playwright's interpolated moves can land inside one millisecond, where the
      touch history rounds them together. The *defect* is 40pt out — the seam
      moved 3 — so a threshold that tolerates an engine losing two points still
      cannot be met by a gesture that died.
    */
    expect(narrowing[2]).toBeLessThan(start - 35);
    // And it tracked the whole way rather than stopping at the first move,
    // which is precisely what the terminated gesture did.
    expect(narrowing[0]).toBeLessThan(start - 5);
    expect(narrowing[1]).toBeLessThan(narrowing[0]);

    const widening = await dragSeam(page, 45);
    expect(widening[2]).toBeGreaterThan(start - 10);
  });

  test("a grab on the half of the handle that lies over the editor is taken", async ({ page }) => {
    /*
      **The second half of the reported defect, and one only a hit test can
      hold.** The strip straddles the column's border because people aim at the
      edge, so three of its seven points lie over the editor — and as the
      column's last child they lay *under* it, since later siblings are on top.
      A press there reached the editor and the handle never heard it: the grab
      that felt ignored, and then "it only works if I start well inside the
      tree".

      Measured in Chromium before the fix: `elementFromPoint` at the middle of
      the handle answered the editor's region rather than the handle.
    */
    const seam = await box(page, "explorer-resizer");
    const outer = seam.x + seam.width - 1;
    const y = seam.y + 200;

    expect(
      await page.evaluate(
        ([px, py]) =>
          (document.elementFromPoint(px, py) as HTMLElement | null)?.getAttribute("data-testid") ??
          "nothing",
        [outer, y],
      ),
    ).toBe("explorer-resizer");

    await page.mouse.move(outer, y);
    await page.mouse.down();
    await page.mouse.move(outer - 30, y, { steps: 6 });
    const moved = await seamX(page);
    await page.mouse.up();

    expect(moved).toBeLessThan(seam.x - 20);
  });

  /**
   * Whether the page can be selected at all, as the engine has resolved it.
   *
   * Computed rather than read off `body.style`, and both spellings rather than
   * one: **Safari's CSSOM has no `userSelect` property**, so an inline read
   * answers `undefined` there and an inline *write* does nothing — which is why
   * the resizer sets `-webkit-user-select` beside it, and why this is the
   * assertion that can tell.
   */
  const selectable = (page: Page) =>
    page.evaluate(() => {
      const computed = getComputedStyle(document.body);
      return (
        computed.getPropertyValue("user-select") ||
        computed.getPropertyValue("-webkit-user-select")
      );
    });

  test("the drag holds the page still while it runs, and hands it back", async ({ page }) => {
    // Keeping the gesture is half of it. The other half is that the page does
    // not paint a selection across the names underneath the drag, and is not
    // left unselectable once it ends — the state only a reload would clear.
    const resting = await selectable(page);
    const seam = await box(page, "explorer-resizer");
    const x = seam.x + seam.width / 2;
    const y = seam.y + 200;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 30, y, { steps: 6 });
    const during = await selectable(page);
    await page.mouse.up();

    expect(during).toBe("none");
    expect(await selectable(page)).toBe(resting);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  });
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
