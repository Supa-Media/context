import { expect, test, type Page } from "@playwright/test";

/*
  The owner's review of the phone Home (2026-10-01), on the homepage's own
  console — the real `ConsoleFrame`, with a visitor's copy of the site, so
  every write stays in the page.

  1. ‹ back at the top left of every page below Home, naming where it goes,
     and no path row above the page any more.
  2. In a note, the bottom bar is the note's actions and the compose button;
     on Home and a folder it is the search field — with no microphone, which
     only ever opened search.
  3. Two new notes in a row are two notes, and neither press is refused.
*/

const content = (page: Page) => page.locator(".cm-content").first();

/** Tap once it has stopped moving: pages slide in, and a tap mid-slide lands short. */
async function touch(page: Page, testID: string): Promise<void> {
  const target = page.getByTestId(testID).first();
  await target.waitFor();
  let box = await target.boundingBox();
  for (let tries = 0; tries < 20; tries++) {
    await page.waitForTimeout(50);
    const next = await target.boundingBox();
    const still = box !== null && next !== null && box.x === next.x && box.y === next.y;
    box = next;
    if (still) break;
  }
  if (box === null) throw new Error(`nothing with test id "${testID}" to tap`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(content(page)).toContainText("Notes for your team", { timeout: 15_000 });
});

test("back walks up a level at a time, naming where it goes, with no path row", async ({ page }) => {
  await expect(page.getByTestId("nav-band")).toHaveCount(0);
  await expect(page.getByTestId("phone-back")).toHaveAccessibleName("Back to Home");
  await touch(page, "phone-back");
  await expect(page.getByTestId("phone-home")).toBeVisible();
  await expect(page.getByTestId("phone-back")).toHaveCount(0);

  await page.getByTestId("phone-home").getByText("Legal", { exact: true }).first().tap();
  await expect(page.getByTestId("phone-folder-head")).toBeVisible();
  await expect(page.getByTestId("phone-back")).toHaveAccessibleName("Back to Home");

  await page.getByTestId("folder-row").first().tap();
  await expect(page.getByTestId("phone-back")).toHaveAccessibleName("Back to Legal");
  await touch(page, "phone-back");
  await expect(page.getByTestId("phone-folder-head")).toBeVisible();
});

test("a note's bottom bar is its actions; Home's is search, and neither has a microphone", async ({ page }) => {
  await expect(page.getByTestId("note-quick-bar")).toBeVisible();
  await expect(page.getByTestId("notes-bar-search")).toHaveCount(0);
  await expect(page.getByTestId("note-quick-copyLink")).toBeVisible();
  await expect(page.getByRole("button", { name: "Search by voice" })).toHaveCount(0);

  await touch(page, "phone-back");
  await expect(page.getByTestId("notes-bar-search")).toBeVisible();
  await expect(page.getByTestId("note-quick-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search by voice" })).toHaveCount(0);
});

test("two quick notes in a row are two notes, and neither is refused", async ({ page }) => {
  /*
    In a folder, on the homepage's local copy of the site: its own create is
    synchronous, so this proves the screen — two presses, two notes, no
    refusal — and `__tests__/quickNoteCreate.test.ts` proves the race itself
    against the signed-in console's slow, real round trips.
  */
  await touch(page, "phone-back");
  await page.getByTestId("phone-home").getByText("Legal", { exact: true }).first().tap();
  await expect(page.getByTestId("folder-row")).toHaveCount(2);
  await touch(page, "notes-bar-compose");
  await expect(page.getByTestId("phone-back")).toHaveAccessibleName("Back to Legal");
  await touch(page, "notes-bar-compose");
  await expect(page.getByText(/already exists/)).toHaveCount(0);
  await touch(page, "phone-back");
  await expect(page.getByTestId("folder-row")).toHaveCount(4);
});
