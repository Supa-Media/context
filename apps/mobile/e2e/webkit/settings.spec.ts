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
 * **Proved red, then green.** `justifyContent: "center"` was put back on
 * `rowTouch`, the export rebuilt, and this file run against it: that case
 * failed with `AI apps: starts 154pt in` against `AI apps: left-aligned`,
 * and the two beside it passed — the defect is a layout one and nothing
 * about opening, pushing or popping the overlay changes when it is present,
 * which is exactly why every other kind of test stayed green while it
 * shipped. With the declaration removed again, all three pass.
 *
 * ## What a pass here proves, and what it does not
 *
 * It proves the overlay mounts, opens on a section, pushes and pops its two
 * phone levels, draws list and panel side by side at a pointer width, and
 * lays its rows out the way the styles claim — inside a real engine, at a
 * real viewport, with real hit-testing. It does not prove anything about the
 * sections whose props the fixture does not supply: `onSignOut` and
 * `onOpenInvitation` are absent there (no session, no router — see
 * `E2EFixtureScreen`'s header), so the sign-out row and the invitation answer
 * are not on this screen to be pressed.
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

/**
 * The way into Settings, now that the fixture's account block has no
 * standalone gear.
 *
 * There used to be one press: `GEAR` named a `PressRow` labelled exactly
 * "Settings", right beside sign-out. `AccountBlock`'s compact form merged
 * that gear into the avatar's own disclosure menu — "the compact corner used
 * to be two controls, and one of them signed you out on one press" is
 * `ConsoleRail.tsx`'s own account of why — so what is beside sign-out now is
 * one control that opens a menu, and Settings is a row in it labelled
 * "Settings…", not "Settings". Two presses where the fixture's account
 * corner needed one, at the phone viewport this file mostly runs at.
 *
 * **The pointer-width case below no longer goes through that menu**, and the
 * paragraph this replaces is why it used to: `E2EFixtureScreen` drew
 * `AccountBlock`'s compact form at every width, because there was no rail on
 * that screen to hold the pointer layout's own gear. The fixture mounts the
 * real `ConsoleRail` at medium and wide now — it had no context switcher above
 * 880pt until it did, see its header — and the account block moved into the
 * rail's foot with it. So the pointer case presses `rail-settings`, which is
 * the control that surface actually has, and the compact menu is what the
 * phone cases press. Both land on the same section: `openSettings()` with no
 * argument answers a context's own Overview either way.
 *
 * The account menu trigger is itself at rest when this file presses it —
 * nothing has opened a panel yet — so it is reached the same way `GEAR` was,
 * through the real-touch coordinate helper below. `ACCOUNT_SETTINGS` is not:
 * it is a row inside `Menu.web.tsx`'s own sliding sheet at a phone width
 * (`Sheet`, `animationType="slide"`, same shape as `SettingsOverlay`'s), so it
 * is pressed with `locator.tap()` for the reason already given above — the
 * actionability wait the coordinate helper cannot do.
 */
const ACCOUNT_MENU = "@seyi — account menu";
/** `MenuItem.testID` for the Settings row in that menu, Sheet and Popover alike. */
const ACCOUNT_SETTINGS = "account-settings";

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
 * The whole of the centring defect, measured rather than described. The row
 * is `flexDirection: "row"` with `paddingHorizontal: 11` and now opens with a
 * 19pt mark and a 12pt gap, so an honest label begins about 42pt in. A
 * centred label in a ~330pt-wide row starts somewhere past 100. `LEFT_EDGE`
 * sits between the two — far enough above the real value to survive a padding
 * token moving, or a mark drawn a point wider, and still nowhere near half a
 * row.
 *
 * It was 48 while the rows had no mark on them, which left six points of
 * headroom: the number moved because the rows did, not because the claim did.
 */
const LEFT_EDGE = 64;

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
  await tap(page, ACCOUNT_MENU);
  await page.getByTestId(ACCOUNT_SETTINGS).tap();

  /*
    Choosing Settings… from the account menu is somebody asking for a *thing*,
    not for a menu — `SettingsOverlay`'s own rule — so the first level is the
    default section, and the list is one press back from it. Both halves are
    asserted: the panel is up, and the list it was pushed over is not.
  */
  await expect(page.getByTestId("settings-overlay")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  /*
    The identity block by its testID rather than by its words. Its second line
    is "Personal workspace · you're the owner" — kind and role in one sentence,
    because being the owner is a fact about you in this context rather than a
    fourth row in a column of properties — so an exact-text match on the kind
    alone no longer names a node, and a looser one would match the section
    list once a row ever previews the same words.
  */
  await expect(page.getByTestId("overview-identity")).toContainText("Personal workspace");
  await expect(page.getByTestId("settings-sections")).toHaveCount(0);

  // Back pops that level rather than closing the overlay.
  await page.getByLabel("Back", { exact: true }).tap();
  await expect(page.getByTestId("settings-sections")).toBeVisible();
  await expect(page.getByTestId("overview-identity")).toHaveCount(0);

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
  await tap(page, ACCOUNT_MENU);
  await page.getByTestId(ACCOUNT_SETTINGS).tap();
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
    /*
      `rail-settings` — the gear in `AccountBlock`'s non-`compact` form, at the
      foot of the rail. This is one press rather than the phone's two because
      the pointer layout's block never merged its gear into a disclosure menu;
      see the header. `hasTouch: false` above rules the coordinate helper out,
      so this is a plain `click`.

      This used to press the compact block's `account-menu`, because the
      fixture drew that form at every width and mounted no rail at all. It
      mounts the real one now, so `account-menu` is not on this screen and this
      control is.
    */
    await page.getByTestId("rail-settings").click();

    // Both at once, which is the whole difference from the phone: no Back,
    // because there is no level to pop.
    await expect(page.getByTestId("settings-sections")).toBeVisible();
    await expect(page.getByTestId("overview-identity")).toBeVisible();
    await expect(page.getByTestId("settings-overlay-back")).toHaveCount(0);

    // The list really is beside the panel rather than above it — the sidebar
    // ends before the panel's content begins.
    const list = await page.getByTestId("settings-sections").boundingBox();
    const panel = await page.getByTestId("overview-identity").boundingBox();
    if (list === null || panel === null) throw new Error("no box for the list or the panel");
    expect(panel.x).toBeGreaterThan(list.x + list.width);

    // A section from the list swaps the panel and leaves the list standing.
    await page.getByTestId("settings-section-storage").click();
    await expect(page.getByText(/Your bucket, your credentials/)).toBeVisible();
    await expect(page.getByTestId("settings-sections")).toBeVisible();
  });
});

/**
 * COMING BACK FROM A PAYMENT, IN A REAL BROWSER.
 *
 * The state this covers had no design and no screen at all until now, and the
 * URL that produces it did not resolve: `billingStripe.ts` sent a completed
 * payment to `/settings?settings=premium&checkout=done`, and `/settings` is
 * not a route in this app. `checkoutReturn.test.ts` proves the new path is one
 * the router has; `premiumPanelRender.test.ts` proves the panel's words. What
 * neither can prove is that the notice is *on the screen* when somebody
 * arrives on that URL, drawn above the plan and legible — which is the class
 * of defect this directory exists for, and the reason the two examples in this
 * file's header shipped past a green suite.
 *
 * The fixture reads `?checkout=` exactly as `(app)/console/_layout.tsx` does,
 * and hands it to the same overlay.
 */
test.describe("back from Stripe", () => {
  test("the payment is acknowledged before the plan has caught up", async ({ page }) => {
    await page.goto(`/e2e-fixture?checkout=done`);
    await page.getByTestId("breadcrumb-leaf").waitFor();
    await tap(page, ACCOUNT_MENU);
    await page.getByTestId(ACCOUNT_SETTINGS).tap();
    await expect(page.getByTestId("settings-overlay")).toBeVisible();
    await page.getByLabel("Back", { exact: true }).tap();
    await page.getByTestId("settings-section-premium").tap();

    const notice = page.getByTestId("premium-checkout-return");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Payment received");

    /*
      Above the plan card, not below it. Somebody who has just paid reads the
      first thing on the section; a reassurance under a card that still says
      "free plan" is a reassurance they meet second, after the alarm.
    */
    const noticeBox = await notice.boundingBox();
    const titleBox = await page.getByTestId("premium-title").boundingBox();
    expect(noticeBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(noticeBox!.y).toBeLessThan(titleBox!.y);

    // And the promise that may never be conditional is still there beneath it.
    await expect(page.getByTestId("premium-export-promise")).toBeVisible();
  });

  test("coming back without paying says so, and sells nothing", async ({ page }) => {
    await page.goto(`/e2e-fixture?checkout=cancelled`);
    await page.getByTestId("breadcrumb-leaf").waitFor();
    await tap(page, ACCOUNT_MENU);
    await page.getByTestId(ACCOUNT_SETTINGS).tap();
    await page.getByLabel("Back", { exact: true }).tap();
    await page.getByTestId("settings-section-premium").tap();

    const notice = page.getByTestId("premium-checkout-return");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("No payment was taken");
  });

  test("an ordinary visit shows no such notice", async ({ page }) => {
    // The negative, in a browser: a section reached without a return URL must
    // not tell somebody anything about a payment they did not make.
    await openConsole(page);
    await tap(page, ACCOUNT_MENU);
    await page.getByTestId(ACCOUNT_SETTINGS).tap();
    await page.getByLabel("Back", { exact: true }).tap();
    await page.getByTestId("settings-section-premium").tap();
    await expect(page.getByTestId("premium-title")).toBeVisible();
    await expect(page.getByTestId("premium-checkout-return")).toHaveCount(0);
  });
});
