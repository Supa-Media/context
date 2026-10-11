import { expect, test } from "@playwright/test";

/**
 * Comments in a real browser: select words, comment, reply, resolve, and the
 * history coming back with Show resolved (files/comments/).
 *
 * A wide desktop window, because the margin is the wide layout; the narrow
 * one opens only the active card under its line.
 */

test.use({
  viewport: { width: 1440, height: 900 },
  isMobile: false,
  hasTouch: false,
});

test("a comment is written, answered and resolved in the margin", async ({
  page,
}) => {
  await page.goto("/e2e-fixture");
  const line = page.locator(".cm-line", { hasText: "Tenancy is bucket-level" });
  await expect(line).toBeVisible();

  // Select the words on one line, as a person would with a double click and drag.
  const box = await line.boundingBox();
  if (box === null) throw new Error("no line to select");
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  const selected = await page.evaluate(
    () => window.getSelection()?.toString() ?? "",
  );
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
  await page
    .locator(".cm-line")
    .filter({ hasNotText: "Tenancy is bucket-level" })
    .first()
    .click();
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

  // Deleting asks first, in the card, and the first comment takes the thread.
  await history.getByRole("button", { name: "Delete this thread" }).click();
  await expect(history).toContainText("Delete this thread and its replies?");
  await expect(page.locator(".cm-cmt-card")).toHaveCount(1);
  await page.screenshot({ path: process.env.COMMENT_SHOT ?? "test-results/comment-delete.png" });
  await history.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".cm-cmt-card")).toHaveCount(0);
  await expect(page.locator(".cm-content")).not.toContainText("<!--c:");
  await expect(line).toContainText("Tenancy is bucket-level");
});

test.describe("a window with a little less room than a card needs", () => {
  // About 200px beside a centred column, so the column eases about 100px left
  // when the note gets its first comment.
  test.use({ viewport: { width: 1100, height: 900 } });

  test("a comment that arrives in the file sits beside the column from its first frame", async ({
    page,
  }) => {
    // Not through the margin's own composer: a comment written into the file by
    // somebody else (an agent, a collaborator, the homepage's cast) arrives as one
    // change, and the column eases left for it at the same moment the card first
    // appears. The card must be placed against where the column is going.
    await page.goto("/e2e-fixture");
    const line = page.locator(".cm-line", {
      hasText: "Tenancy is bucket-level",
    });
    await expect(line).toBeVisible();
    const box = await line.boundingBox();
    if (box === null) throw new Error("no line to click");
    await page.mouse.click(box.x + 4, box.y + box.height / 2);
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(
      '\n\n<!--c:ab12-->Arrived<!--/c:ab12--> from elsewhere.\n\n```comments\nab12 "Arrived"\n- 2026-09-27T07:30:12Z Codex: This seems a little unprofessional.\n```\n',
    );
    const card = page.locator(".cm-cmt-card", {
      hasText: "This seems a little unprofessional",
    });
    await expect(card).toBeVisible();
    // Past the column's ease, with nothing else happening in the note.
    await page.waitForTimeout(600);
    const scroller = await page.locator(".cm-scroller").boundingBox();
    const placed = await card.boundingBox();
    if (scroller === null || placed === null)
      throw new Error("nothing to measure");
    expect(placed.x + placed.width).toBeLessThanOrEqual(
      scroller.x + scroller.width,
    );
    const column = await line.boundingBox();
    expect(placed.x).toBeGreaterThan(
      (column?.x ?? 0) + (column?.width ?? 0) - 1,
    );
  });
});

test("a paragraph with more comments than room folds the extras into one row beside it", async ({
  page,
}) => {
  // Dev2, 2026-10-10: with many comments on one paragraph, cards were pushed
  // away from their words and, once one was clicked, onto each other.
  await page.goto("/e2e-fixture");
  const line = page.locator(".cm-line", { hasText: "Tenancy is bucket-level" });
  await expect(line).toBeVisible();
  const box = await line.boundingBox();
  if (box === null) throw new Error("no line to click");
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(
    [
      "",
      "",
      "<!--c:aa01-->One<!--/c:aa01--> <!--c:aa02-->two<!--/c:aa02--> <!--c:aa03-->three<!--/c:aa03--> <!--c:aa04-->four<!--/c:aa04--> words.",
      "",
      "```comments",
      'aa01 "One"',
      "- 2026-10-10T04:00:00Z @sayo: Can we say forever? Legal wants it gone, and this needs a longer card.",
      'aa02 "two"',
      "- 2026-10-10T04:01:00Z Codex: Out of date: the free plan is 1,000 notes now.",
      'aa03 "three"',
      "- 2026-10-10T04:02:00Z @john: And put no card first.",
      'aa04 "four"',
      "- 2026-10-10T04:03:00Z Claude: Link this to the Premium page.",
      "```",
      "",
    ].join("\n"),
  );
  const fold = page.locator(".cm-cmt-fold");
  await expect(fold).toHaveCount(1);
  await expect(fold).toContainText("more here");
  await page.waitForTimeout(400);

  const visibleBoxes = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".cm-cmt-card, .cm-cmt-fold")]
        .filter((node) => getComputedStyle(node).visibility !== "hidden")
        .map((node) => node.getBoundingClientRect())
        .map((rect) => ({ top: rect.top, bottom: rect.bottom }))
        .sort((a, b) => a.top - b.top),
    );
  const noOverlap = (boxes: { top: number; bottom: number }[]) => {
    for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]!.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom - 0.5);
  };
  const closed = await visibleBoxes();
  // The first card, and one row for the rest, both beside the paragraph.
  expect(closed).toHaveLength(2);
  noOverlap(closed);

  await fold.getByRole("button", { name: "Show" }).click();
  await expect(fold).toContainText("comments here");
  await page.waitForTimeout(400);
  const open = await visibleBoxes();
  expect(open).toHaveLength(5);
  noOverlap(open);
  // Opening the row moves nothing above it: the first card stays level with its words.
  const words = await page.locator(".cm-cmt-hl", { hasText: "One" }).boundingBox();
  expect(Math.abs(open[0]!.top - (words?.y ?? NaN))).toBeLessThan(24);

  // Clicking a folded thread's words opens its row too.
  await fold.getByRole("button", { name: "Hide" }).click();
  await expect(fold).toContainText("more here");
  await page.locator(".cm-cmt-hl", { hasText: "four" }).click();
  await expect(page.locator(".cm-cmt-card-active")).toContainText("Link this to the Premium page");
  await page.waitForTimeout(400);
  noOverlap(await visibleBoxes());
});
