import { expect, test, type Page } from "@playwright/test";

/**
 * Pasting into a note, far down it.
 *
 * Dev2, 2026-10-11: "when I paste something into a note, the page shoots all
 * the way back to the top", reported as the same family as the comment box
 * that was focused before it was placed (`comments.spec.ts`). These hold the
 * page where it was through a paste on both layouts, and keep the words of a
 * clipboard that also carries a picture of them (Word, Excel, Numbers, Google
 * Sheets), which used to paste the picture instead.
 */

async function caretFarDown(page: Page) {
  await page.goto("/e2e-fixture");
  const first = page.locator(".cm-line", { hasText: "Tenancy is bucket-level" });
  await expect(first).toBeVisible();
  const box = await first.boundingBox();
  if (box === null) throw new Error("no line to click");
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await page.keyboard.press("ControlOrMeta+End");
  const filler = Array.from({ length: 120 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n");
  await page.keyboard.insertText(`\n\n${filler}\n\nWords far down the note.\n\nLast.`);
  const far = page.locator(".cm-line", { hasText: "Words far down the note." });
  await far.scrollIntoViewIfNeeded();
  const farBox = await far.boundingBox();
  if (farBox === null) throw new Error("no line to paste into");
  await page.mouse.click(farBox.x + farBox.width - 2, farBox.y + farBox.height / 2);
  await page.keyboard.press("End");
  await page.waitForTimeout(300);
}

/** The scroll offset of whatever is scrolling the note on this layout. */
const scrolled = (page: Page) =>
  page.evaluate(() =>
    Math.max(0, ...[...document.querySelectorAll<HTMLElement>("*")].map((node) => node.scrollTop)),
  );

async function paste(page: Page, text: string, withPicture = false) {
  await page.evaluate(
    ({ text, withPicture }) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      if (withPicture) {
        const png = Uint8Array.from(
          atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
          (c) => c.charCodeAt(0),
        );
        data.items.add(new File([png], "image.png", { type: "image/png" }));
      }
      document
        .querySelector(".cm-content")!
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { text, withPicture },
  );
}

for (const [layout, viewport] of [
  ["desktop", { width: 1400, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`pasting far down a note keeps the page where it is (${layout})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await caretFarDown(page);
    const before = await scrolled(page);
    expect(before).toBeGreaterThan(500);

    await paste(page, "\n\nPasted one.\n\nPasted two.\n\n- a\n- b\n");
    await page.waitForTimeout(400);
    expect(await scrolled(page)).toBeGreaterThan(before - 50);
    await expect(page.locator(".cm-line", { hasText: "Pasted two." })).toBeInViewport();
  });
}

test("text copied with a picture of itself pastes as the text", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await caretFarDown(page);
  const before = await scrolled(page);
  await paste(page, " cell one\tcell two", true);
  await expect(page.locator(".cm-line", { hasText: "cell one" })).toBeInViewport();
  expect(await scrolled(page)).toBeGreaterThan(before - 50);
});

/*
  The same family through the table menu: deleting a row redraws the table and
  puts the caret back into a cell of the new one. Focusing that cell let the
  browser choose the scroll, which can be the top of the note.
*/
test("deleting a table row far down a note keeps the page where it is", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/e2e-fixture");
  const first = page.locator(".cm-line", { hasText: "Tenancy is bucket-level" });
  await expect(first).toBeVisible();
  const box = await first.boundingBox();
  await page.mouse.click(box!.x + 4, box!.y + box!.height / 2);
  await page.keyboard.press("ControlOrMeta+End");
  const filler = Array.from({ length: 120 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n");
  await page.keyboard.insertText(
    `\n\n${filler}\n\n| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\nAfter the table.\n\nLast.`,
  );
  const after = page.locator(".cm-line", { hasText: "After the table." });
  await after.scrollIntoViewIfNeeded();
  const below = await after.boundingBox();
  await page.mouse.click(below!.x + below!.width - 2, below!.y + below!.height / 2);
  const grid = page.locator(".cm-lp-grid-live").last();
  await expect(grid).toBeVisible();
  await grid.scrollIntoViewIfNeeded();
  const before = await scrolled(page);
  expect(before).toBeGreaterThan(1000);
  await grid.locator('[data-lp-row="0"]').first().hover();
  await page.getByRole("button", { name: "Row 1 actions" }).last().click({ force: true });
  const menu = page.locator(".cm-lp-grid-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Delete row" }).click();
  await expect(grid.locator('[data-lp-row="1"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(Math.abs((await scrolled(page)) - before)).toBeLessThan(400);
});
