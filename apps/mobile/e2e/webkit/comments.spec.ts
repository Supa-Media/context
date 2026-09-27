import { expect, test } from "@playwright/test";

/**
 * Comments in a real browser: select words, comment, reply, resolve, and the
 * history coming back with Show resolved (files/comments/).
 *
 * A wide desktop window, because the margin is the wide layout; the narrow
 * one opens only the active card under its line.
 */

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

test("a comment is written, answered and resolved in the margin", async ({ page }) => {
  await page.goto("/e2e-fixture");
  const line = page.locator(".cm-line", { hasText: "Tenancy is bucket-level" });
  await expect(line).toBeVisible();

  // Select the words on one line, as a person would with a double click and drag.
  const box = await line.boundingBox();
  if (box === null) throw new Error("no line to select");
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.trim().length).toBeGreaterThan(0);

  await page.locator(".cm-cmt-chip").click();
  const input = page.locator(".cm-cmt-card textarea");
  await expect(input).toBeFocused();
  await input.fill("This seems a little unprofessional. Maybe tone it down.");
  await page.keyboard.press("Enter");

  const card = page.locator(".cm-cmt-card").first();
  await expect(card).toContainText("This seems a little unprofessional");
  await expect(page.locator(".cm-cmt-hl")).toHaveCount(1);
  // The markers and the block never reach the screen.
  await expect(page.locator(".cm-content")).not.toContainText("<!--c:");
  await expect(page.locator(".cm-content")).not.toContainText("```comments");

  // Opening and closing a card never moves the text being read.
  const textLeft = async () => (await line.boundingBox())?.x ?? NaN;
  await page.waitForTimeout(400);
  const settled = await textLeft();
  await page.locator(".cm-line").filter({ hasNotText: "Tenancy is bucket-level" }).first().click();
  await expect(page.locator(".cm-cmt-card-active")).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(await textLeft()).toBe(settled);
  await page.locator(".cm-cmt-hl").click();
  await page.waitForTimeout(400);
  expect(await textLeft()).toBe(settled);

  await card.locator("textarea").fill("eh, I don't really care");
  await page.keyboard.press("Enter");
  await expect(card).toContainText("eh, I don't really care");

  await card.getByRole("button", { name: "Resolve" }).click();
  await expect(page.locator(".cm-cmt-card")).toHaveCount(0);
  await expect(page.locator(".cm-cmt-hl")).toHaveCount(0);

  await page.getByRole("button", { name: "Show resolved (1)" }).click();
  const history = page.locator(".cm-cmt-card");
  await expect(history).toContainText("Resolved by");
  await expect(history).toContainText("eh, I don't really care");
});
