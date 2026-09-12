import { expect, test } from "@playwright/test";

/**
 * The storage step, in a real browser engine.
 *
 * ## Why this file exists
 *
 * `/welcome` needs a session and a Convex deployment, so the first run has
 * never been on a browser-reachable screen — and the three screens this covers
 * are all *layouts*: a card in a row of cards, a toggle group over a price
 * row, a step list under a pill. jsdom lays nothing out, which is the class
 * `docs/decisions/testing.md` puts in this directory, and the very first
 * defect in this work was one of them: the full-width managed card carried
 * `flexBasis: "100%"` in a **column**, where that is the *height*, so it asked
 * for the whole step and drew itself over the skip button and the footer. It
 * type-checked. Every jsdom assertion about its text passed.
 *
 * `?screen=first-run-storage` mounts the shipping `StorageStepBody` inside the
 * shipping `WelcomeChrome`, with the conversation with billing replaced by
 * three `useState` calls (`FirstRunStorageFixture`). Nothing here can reach an
 * account, a bucket or a card.
 *
 * **Proved red, then green.** With `flexBasis: "100%"` put back, "the paid
 * card does not draw over the rest of the step" fails on the overlap and the
 * text assertions beside it pass — which is exactly the split that let the
 * defect ship in the first place.
 */

const STORAGE = "/e2e-fixture?screen=first-run-storage";

test("the three answers are in order, and the paid one says what it costs", async ({ page }) => {
  await page.goto(STORAGE);
  await page.getByTestId("choose-bucket").waitFor();

  const bucket = await page.getByTestId("choose-bucket").boundingBox();
  const dropbox = await page.getByTestId("choose-dropbox").boundingBox();
  const managed = await page.getByTestId("choose-managed").boundingBox();
  expect(bucket).not.toBeNull();
  expect(dropbox).not.toBeNull();
  expect(managed).not.toBeNull();

  /*
    Free first, paid below — on a phone that is three rows, and at a pointer
    width it is two beside each other with the third under them. Both are the
    same rule: a screen that sold above a free option would be selling against
    its own free tier.
  */
  expect(managed!.y).toBeGreaterThan(bucket!.y);
  expect(managed!.y).toBeGreaterThan(dropbox!.y);
  await expect(page.getByTestId("choose-managed")).toContainText("$20 a month");
});

test("the paid card does not draw over the rest of the step", async ({ page }) => {
  /*
    THE DEFECT THIS FILE EXISTS FOR.

    A card that overlaps the controls under it is not a styling nit: the skip
    button — the way out of this step for somebody who has no storage — was
    inside its border and unreachable-looking. Measured rather than described,
    the way `settings.spec.ts` measures its centring bug.
  */
  await page.goto(STORAGE);
  const managed = page.getByTestId("choose-managed");
  await managed.waitFor();
  const card = await managed.boundingBox();
  const skip = await page.getByTestId("welcome-storage-skip").boundingBox();
  expect(card).not.toBeNull();
  expect(skip).not.toBeNull();
  expect(
    skip!.y >= card!.y + card!.height
      ? "below the card"
      : `overlapping the card by ${Math.round(card!.y + card!.height - skip!.y)}pt`,
  ).toBe("below the card");
});

test("pressing it asks before it charges", async ({ page }) => {
  await page.goto(STORAGE);
  await page.getByTestId("choose-managed").tap();

  // The price, the unit, and the exit — all three on the screen before Stripe.
  await expect(page.getByTestId("managed-confirm-price")).toContainText("$20 a month");
  await expect(page.getByTestId("managed-confirm-unit")).toContainText("nothing else");
  await expect(page.getByTestId("managed-confirm-export-promise")).toBeVisible();

  // And it is reversible without paying, which is the whole reason it is a
  // screen rather than a redirect.
  await page.getByTestId("managed-confirm-back").tap();
  await expect(page.getByTestId("choose-bucket")).toBeVisible();
});

test("a deployment that cannot provide it never mentions it", async ({ page }) => {
  await page.goto(`${STORAGE}&available=no`);
  await page.getByTestId("choose-bucket").waitFor();
  await expect(page.getByTestId("choose-managed")).toHaveCount(0);
  // Absent, not disabled, and the free paths are exactly as they were.
  await expect(page.getByTestId("choose-dropbox")).toBeVisible();
  await expect(page.getByTestId("welcome-storage-skip")).toBeVisible();
});

test("coming back from Stripe waits without alarming anybody", async ({ page }) => {
  await page.goto(`${STORAGE}&at=settling`);
  await expect(page.getByTestId("managed-settling-steps")).toBeVisible();
  const body = (await page.locator("body").textContent()) ?? "";
  expect(body).toContain("Payment received");
  expect(body.toLowerCase()).not.toContain("failed");
});

test("and a wait that has gone on too long offers a way out", async ({ page }) => {
  await page.goto(`${STORAGE}&at=settling&slow=yes`);
  await expect(page.getByTestId("managed-settling-slow")).toBeVisible();
  await expect(page.getByTestId("managed-settling-own")).toBeVisible();
  await expect(page.getByTestId("managed-settling-carry-on")).toBeVisible();
});

test("provisioning that failed says the money is safe, and offers both ways on", async ({
  page,
}) => {
  /*
    Money taken and nothing delivered — the state this whole flow is judged on.
    In a browser because the previous two defects in this work were layouts,
    and because a person reading this one is already unhappy: the sentences and
    the buttons have to be on screen together, not one below a fold.
  */
  await page.goto(`${STORAGE}&at=settling&failed=yes`);
  const body = page.locator("body");
  await expect(page.getByTestId("managed-settling-own")).toBeVisible();
  await expect(body).toContainText("Your payment went through");
  await expect(body).toContainText("will not create a second copy");
  await expect(page.getByTestId("managed-settling-retry")).toBeVisible();
  // Not still pretending to work.
  await expect(page.getByTestId("managed-settling-steps")).toHaveCount(0);
});

test.describe("at a pointer width", () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

  test("the two free cards share a row and the paid one has its own", async ({ page }) => {
    await page.goto(STORAGE);
    await page.getByTestId("choose-bucket").waitFor();
    const bucket = (await page.getByTestId("choose-bucket").boundingBox())!;
    const dropbox = (await page.getByTestId("choose-dropbox").boundingBox())!;
    const managed = (await page.getByTestId("choose-managed").boundingBox())!;

    // Side by side: same top, different left.
    expect(Math.abs(bucket.y - dropbox.y)).toBeLessThan(2);
    expect(dropbox.x).toBeGreaterThan(bucket.x);
    // And the third spans both of them rather than sitting in a third column.
    expect(managed.y).toBeGreaterThan(bucket.y + bucket.height - 2);
    expect(managed.width).toBeGreaterThan(bucket.width * 1.8);
  });
});
