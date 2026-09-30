import { expect, test, type Page } from "@playwright/test";

/*
  A phone's folder page and search, with real touch (boards 03, 14 and 16
  of the phone Home artboards, approved by the owner on 2026-09-30), on the
  homepage's own site: a visitor there edits a copy in their tab, so every
  write below stays in the page.

  1. Search's Look in: pick Folders, keep typing, and the folder is there
     to open. (That a chip hands the caret back to the field, for a mouse or
     a keyboard, is `paletteRender/lookIn.test.ts`'s: a touch never took it.)
  2. Tags, from a folder's •••, opens with the caret in its field. A sheet
     opened from a menu sheet used to open with none: the closing menu gave
     focus back to •••, and the web modal then put it on its scrim.
  3. Select notes, from the same •••, trades the search bar for Move, Tags,
     Pin, Archive and More, and Cancel gives search back.
*/

/** Tap once it has stopped moving: search and the sheets slide in, and a tap mid-slide lands on the scrim. */
async function touch(page: Page, testID: string, nth = 0): Promise<void> {
  const target = page.getByTestId(testID).nth(nth);
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

async function openLegal(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Notes for your team", { timeout: 15_000 });
  // From Home, where every folder is: the site's pages are notes at the top, and Legal is its one folder.
  await page.getByLabel("@context, the context you are in — open its root", { exact: true }).tap();
  await expect(page.getByTestId("phone-home")).toBeVisible();
  await touch(page, "notes-bar-search");
  await expect(page.getByTestId("palette-input")).toBeFocused();
  await touch(page, "look-in-folders");
  await page.keyboard.type("leg");
  await expect(page.getByTestId("search-folder")).toHaveCount(1);
  await touch(page, "search-folder");
  await expect(page.getByTestId("folder-row").first()).toBeVisible();
}

test("Look in narrows to folders, and a folder found opens its page", async ({ page }) => {
  await openLegal(page);
  await expect(page.getByTestId("phone-folder-head")).toBeVisible();
});

test("Tags from a folder's ••• opens with the caret in its field", async ({ page }) => {
  await openLegal(page);
  await touch(page, "phone-folder-actions");
  await touch(page, "menu-item-tags");
  await expect(page.getByLabel("Add a tag", { exact: true })).toBeFocused();
  await page.keyboard.type("policy");
  await expect(page.getByTestId("tag-new")).toHaveAccessibleName("Add “policy” as a new tag");
});

test("Select notes trades search for the picked rows' actions, and Cancel gives it back", async ({ page }) => {
  await openLegal(page);
  await touch(page, "phone-folder-actions");
  await touch(page, "menu-item-selectNotes");
  await expect(page.getByTestId("folder-select-count")).toHaveText("0 selected");
  await expect(page.getByTestId("notes-bar")).toHaveCount(0);
  await expect(page.getByTestId("select-move")).toBeDisabled();
  await touch(page, "folder-row");
  await expect(page.getByTestId("folder-select-count")).toHaveText("1 selected");
  for (const key of ["select-move", "select-archive", "select-more"]) await expect(page.getByTestId(key)).toBeEnabled();
  await touch(page, "folder-select-done");
  await expect(page.getByTestId("notes-bar")).toBeVisible();
  await expect(page.getByTestId("select-actions")).toHaveCount(0);
});
