import { expect, test } from "@playwright/test";

/**
 * `activity.md`, OPENED, IN A REAL BROWSER.
 *
 * This page had no browser coverage at all, and the defect that came of that
 * is the one a person found in a screenshot: the list drew in a column of its
 * own — a hard 760, pinned to the left edge — while the note editor beside it
 * uses a centred measure. Nothing in jsdom can see it, because
 * react-native-web compiles styles to classes and lays nothing out; the unit
 * suite says so where the assertion used to be.
 *
 * So the claim is made where it is a fact: **the page's text column is the
 * note's text column.** Pressing the pencil swaps this list for the editor
 * over the same file, and text that moved sideways at the press would make the
 * two read as different documents — which is exactly what the page exists to
 * deny.
 */

const FRAME = "/e2e-fixture?screen=app-frame-visual";

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

test.beforeEach(async ({ page }) => {
  await page.goto(FRAME);
  await page.getByTestId("explorer-tree").waitFor();
});

/** Open `activity.md` from the tree, the way a person would. */
async function openActivity(page: import("@playwright/test").Page) {
  await page.getByTestId("explorer-activity").click();
  await page.getByRole("button", { name: /Open the whole history/ }).click();
}

test("the list opens as a page, centred on the note's own measure", async ({ page }) => {
  // The note the fixture opens with, measured before anything moves.
  const note = await page.getByText("Tenancy is bucket-level").boundingBox();

  await openActivity(page);
  const heading = page.getByText("Activity", { exact: true }).first();
  await expect(heading).toBeVisible();

  const title = await heading.boundingBox();
  if (note === null || title === null) throw new Error("nothing drawn");

  // The left edge of the activity page's text is the left edge of the note's
  // text. One point of tolerance for sub-pixel rounding, and no more: this is
  // a shared constant, so any real difference is two columns rather than one.
  expect(Math.abs(title.x - note.x)).toBeLessThan(1.5);

  // And it is genuinely centred rather than merely indented — there is as much
  // room to its right as to its left, within the region it was given.
  const region = await page.getByTestId("explorer-tree").boundingBox();
  if (region === null) throw new Error("no tree");
  const left = title.x - (region.x + region.width);
  const right = 1440 - (title.x + title.width);
  expect(Math.abs(left - right)).toBeLessThan(40);
});

test("it says it is a file, and that the file is yours", async ({ page }) => {
  await openActivity(page);
  // The sentence the whole design rests on, on the glass rather than in a
  // component test: a rendering that hides what it is rendering is how a
  // product ends up owning somebody's data by accident.
  await expect(page.getByText(/a note in your own storage/)).toBeVisible();
});
