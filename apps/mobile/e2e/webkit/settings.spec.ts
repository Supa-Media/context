import { expect, test, type Locator, type Page } from "@playwright/test";
import { tap } from "./helpers";

/**
 * Settings, opened in a real browser — which nothing in this repository could
 * do until `E2EFixtureScreen` wired the overlay.
 *
 * ## Why this file exists
 *
 * `SettingsOverlay` is a large surface with a full jsdom suite behind it, and
 * every defect that has actually shipped from it passed that suite green and
 * was found by a person hand-writing a throwaway route and looking at it:
 *
 *  - `rowTouch` carried `justifyContent: "center"`. It was written as the
 *    vertical centring of a column and became **horizontal** centring the
 *    moment the row grew a dot and a trailing label and turned into a flex
 *    row — so every section label in the phone's list sat in the middle of
 *    its row. jsdom lays nothing out, so nothing could see it;
 *  - a temporal dead zone (a `const` read by a closure declared above it)
 *    crashed the whole overlay behind an error boundary, with typecheck
 *    clean;
 *  - a panel that was a heading over an empty page.
 *
 * All three are "the code is right and the screen is wrong", which is the
 * class `docs/decisions/testing.md` puts in this directory. The centring one
 * is the case this file is measured against: reintroduce that single
 * declaration and `the phone's section labels are left-aligned` must go red,
 * or this file is decoration.
 *
 * ## What a pass here proves, and what it does not
 *
 * It proves the overlay mounts, opens on a section, pushes and pops its two
 * phone levels, draws list and panel side by side at a pointer width, and
 * lays its rows out the way the styles claim — inside a real engine, at a
 * real viewport, with real hit-testing. It does not prove anything about the
 * sections whose props the fixture does not supply: `onSignOut`,
 * `onOpenInvitation` and `onOpenSection` are absent there (no session, no
 * router — see `E2EFixtureScreen`'s header), so the sign-out row, the
 * invitation answer and the "Elsewhere in the console" card are not on this
 * screen to be pressed.
 *
 * ## Why the presses inside the overlay are `locator.tap()`
 *
 * `helpers.ts`'s `tap` reads a `boundingBox()` and then taps that point, and
 * everything it is used on here — the console behind the scrim — is already
 * at rest. The overlay is not: `Overlay` mounts a `Modal` with
 * `animationType="slide"`, so for a few hundred milliseconds after it becomes
 * visible its head is still travelling up the screen and a coordinate read
 * before the press lands somewhere the button has already left. Measured
 * here, on this export: a tap through the helper at that moment did nothing
 * at all, silently, and the list never appeared. `locator.tap()` is the same
 * real touch through the same input pipeline — it is Playwright's own
 * `Touchscreen` under an actionability check that waits for the element to
 * stop moving first, which is the half the helper cannot do.
 */

/** The gear in the fixture's account block — the phone console's own way in. */
const GEAR = "Settings";

async function openConsole(page: Page): Promise<void> {
  await page.goto("/e2e-fixture");
  /*
    The breadcrumb rather than `note-scroll`: the fixture's default note is
    drawn by a scroller on a phone and by the live editor at a pointer width,
    and this file runs at both. The leaf is the one landmark both layouts
    paint, and painting it means the demo data and the tree behind it have
    already resolved.
  */
  await page.getByTestId("breadcrumb-leaf").waitFor();
}

/**
 * How far a row's label starts from the row's own left edge.
 *
 * The whole of the centring defect, measured rather than described: the row
 * is `flexDirection: "row"` with `paddingHorizontal: 9`, so an honest label
 * begins 9pt in — plus a dot and its gap on a context row, which is the
 * widest legitimate answer here and still nowhere near half a row. A centred
 * label in a ~330pt-wide row starts somewhere past 100. `LEFT_EDGE` sits
 * between the two, close enough to the real value to fail on the defect and
 * loose enough not to break on a padding token moving by a point or two.
 */
const LEFT_EDGE = 48;

async function labelOffset(row: Locator, label: string): Promise<number> {
  const rowBox = await row.boundingBox();
  const textBox = await row.getByText(label, { exact: true }).boundingBox();
  if (rowBox === null || textBox === null) {
    throw new Error(`no box for the row labelled "${label}"`);
  }
  return textBox.x - rowBox.x;
}

test("a phone opens settings on a section, and Back is the way to the list", async ({ page }) => {
  await openConsole(page);
  await tap(page, GEAR);

  /*
    Opening from the gear is somebody asking for a *thing*, not for a menu —
    `SettingsOverlay`'s own rule — so the first level is the default section,
    and the list is one press back from it. Both halves are asserted: the
    panel is up, and the list it was pushed over is not.
  */
  await expect(page.getByTestId("settings-overlay")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByText("Personal brain", { exact: true })).toBeVisible();
  await expect(page.getByTestId("settings-sections")).toHaveCount(0);

  // Back pops that level rather than closing the overlay.
  await page.getByLabel("Back", { exact: true }).tap();
  await expect(page.getByTestId("settings-sections")).toBeVisible();
  await expect(page.getByText("Personal brain", { exact: true })).toHaveCount(0);

  // And a row from the list draws its own section, which is the `onSelect`
  // wiring the fixture stands in for `router.setParams({ settings })` with.
  await page.getByTestId("settings-section-storage").tap();
  await expect(page.getByText(/Your bucket, your credentials/)).toBeVisible();
  await expect(page.getByTestId("settings-sections")).toHaveCount(0);

  // Closing leaves the console exactly where it was — the note behind the
  // overlay was never navigated away from.
  await page.getByLabel("Close settings", { exact: true }).tap();
  await expect(page.getByTestId("settings-overlay")).toHaveCount(0);
  await expect(page.getByTestId("breadcrumb-leaf")).toBeVisible();
});

test("the phone's section labels are left-aligned, not centred", async ({ page }) => {
  await openConsole(page);
  await tap(page, GEAR);
  await expect(page.getByTestId("settings-overlay")).toBeVisible();
  await page.getByLabel("Back", { exact: true }).tap();
  await expect(page.getByTestId("settings-sections")).toBeVisible();

  /*
    Every section row on screen, not a sampled one: the defect was a style on
    `rowTouch`, which every row in this list wears, and a spot check on one
    row is how a list ends up half-checked. Context rows are deliberately not
    in this sweep — their trailing "yours" carries `marginLeft: "auto"`, and
    an auto margin absorbs the free space *before* `justify-content` ever sees
    it, so a centring bug cannot show on them. The rows that break are exactly
    the ones with nothing to absorb it.
  */
  const rows = page.locator('[data-testid^="settings-section-"]');
  const count = await rows.count();
  // The list is the account sections plus the open context's own, which is
  // more than a handful; a locator that matched nothing would otherwise
  // satisfy every assertion below it.
  expect(count).toBeGreaterThanOrEqual(8);

  for (let index = 0; index < count; index++) {
    const row = rows.nth(index);
    const label = (await row.getAttribute("aria-label")) ?? "";
    expect(label).not.toBe("");
    const offset = await labelOffset(row, label);
    expect(
      `${label}: ${offset < LEFT_EDGE ? "left-aligned" : `starts ${Math.round(offset)}pt in`}`,
    ).toBe(`${label}: left-aligned`);
  }
});

test.describe("at a pointer width", () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

  test("the list and the panel are on screen together", async ({ page }) => {
    await openConsole(page);
    await page.getByLabel(GEAR, { exact: true }).click();

    // Both at once, which is the whole difference from the phone: no Back,
    // because there is no level to pop.
    await expect(page.getByTestId("settings-sections")).toBeVisible();
    await expect(page.getByText("Personal brain", { exact: true })).toBeVisible();
    await expect(page.getByTestId("settings-overlay-back")).toHaveCount(0);

    // The list really is beside the panel rather than above it — the sidebar
    // ends before the panel's content begins.
    const list = await page.getByTestId("settings-sections").boundingBox();
    const panel = await page.getByText("Personal brain", { exact: true }).boundingBox();
    if (list === null || panel === null) throw new Error("no box for the list or the panel");
    expect(panel.x).toBeGreaterThan(list.x + list.width);

    // A section from the list swaps the panel and leaves the list standing.
    await page.getByTestId("settings-section-storage").click();
    await expect(page.getByText(/Your bucket, your credentials/)).toBeVisible();
    await expect(page.getByTestId("settings-sections")).toBeVisible();
  });
});
