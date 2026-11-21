import { expect, test } from "@playwright/test";

/**
 * Comments in a real browser: select words, comment from the selection
 * toolbar, reply, resolve (no "Show resolved" line in the note: Dev2,
 * 2026-11-21), the history coming back with ⌘Z
 * (files/comments/).
 *
 * Threads open in a card under their words (Dev2's in-note Tex mock,
 * 2026-11-20, https://claude.ai/artifact/G8Udcec7fUh8jD7dnHkUN7), which
 * replaced the margin of cards on wide panes.
 */

test.use({
  viewport: { width: 1440, height: 900 },
  isMobile: false,
  hasTouch: false,
});

async function selectLine(page: import("@playwright/test").Page, text: string) {
  const line = page.locator(".cm-line", { hasText: text });
  await expect(line).toBeVisible();
  const box = await line.boundingBox();
  if (box === null) throw new Error("no line to select");
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.trim().length).toBeGreaterThan(0);
  return line;
}

test("a comment is written, answered and resolved under its words", async ({ page }) => {
  await page.goto("/e2e-fixture");
  const line = await selectLine(page, "Tenancy is bucket-level");

  // The selection toolbar: a comment icon and (with Tex in the note) a Tex icon, nothing else.
  const toolbar = page.locator(".cm-seltool");
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: /Comment/ }).click();
  const card = page.locator(".cm-cw");
  const input = card.locator(".cm-cwin");
  await expect(input).toBeFocused();
  await input.fill("This seems a little unprofessional. Maybe tone it down.");
  await page.keyboard.press("Enter");

  await expect(card).toContainText("This seems a little unprofessional");
  await expect(page.locator(".cm-cmt-hl")).toHaveCount(1);
  // The markers and the block never reach the screen.
  await expect(page.locator(".cm-content")).not.toContainText("<!--c:");
  await expect(page.locator(".cm-content")).not.toContainText("```comments");

  // The card never covers its words: beside them in the comments margin when
  // the pane has room for it, docked below them when it does not. Opening it
  // never moves the text.
  const words = await page.locator(".cm-cmt-hl").boundingBox();
  const placed = await card.boundingBox();
  if (await card.evaluate((node) => node.classList.contains("cm-cw-margin"))) {
    expect(placed!.x).toBeGreaterThanOrEqual(words!.x + words!.width);
    expect(Math.abs(placed!.y - words!.y)).toBeLessThan(words!.height * 2);
  } else {
    expect(placed!.y).toBeGreaterThanOrEqual(words!.y + words!.height - 1);
  }
  const textLeft = async () => (await line.boundingBox())?.x ?? NaN;
  const settled = await textLeft();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  expect(await textLeft()).toBe(settled);
  await page.locator(".cm-cmt-hl").click();
  await expect(card).toBeVisible();
  expect(await textLeft()).toBe(settled);

  await card.locator(".cm-cwin").fill("eh, I don't really care");
  await page.keyboard.press("Enter");
  await expect(card).toContainText("eh, I don't really care");

  await card.getByRole("button", { name: "Resolve" }).click();
  await expect(page.locator(".cm-cmt-hl")).toHaveCount(0);

  await expect(page.getByRole("button", { name: /Show resolved/ })).toHaveCount(0);
  // Undo brings the thread back: resolving is an edit to the file like any other.
  await line.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(page.locator(".cm-cmt-hl")).toHaveCount(1);
  await page.locator(".cm-cmt-hl").click();
  await expect(card).toBeVisible();

  // Deleting asks first, in the card, and the first comment takes the thread.
  await card.getByRole("button", { name: "Delete this thread" }).click();
  await expect(card).toContainText("Delete this thread and its replies?");
  if (process.env.E2E_CSP_NONCE !== "1") await page.screenshot({ path: process.env.COMMENT_SHOT ?? "test-results/comment-delete.png" });
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".cm-cmt-hl")).toHaveCount(0);
  await expect(page.locator(".cm-content")).not.toContainText("<!--c:");
  await expect(line).toContainText("Tenancy is bucket-level");
});

test("⌘M comments on the selection, and a thread far down a note keeps the page where it is", async ({ page }) => {
  // Dev2, 2026-10-11: highlighting words and pressing Comment jumped back to
  // the top of the note. The new card's box was focused before it had been
  // placed, so the browser scrolled to where it first stood.
  await page.goto("/e2e-fixture");
  const first = page.locator(".cm-line", { hasText: "Tenancy is bucket-level" });
  await expect(first).toBeVisible();
  const box = await first.boundingBox();
  if (box === null) throw new Error("no line to click");
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await page.keyboard.press("ControlOrMeta+End");
  const filler = Array.from({ length: 120 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n");
  await page.keyboard.insertText(`\n\n${filler}\n\nWords far down the note.`);
  const far = page.locator(".cm-line", { hasText: "Words far down the note." });
  await far.scrollIntoViewIfNeeded();
  await expect(far).toBeInViewport();

  const scroller = page.locator(".cm-scroller");
  await selectLine(page, "Words far down the note.");
  const before = await scroller.evaluate((node) => node.scrollTop);
  expect(before).toBeGreaterThan(500);

  await page.keyboard.press("ControlOrMeta+m");
  const input = page.locator(".cm-cw .cm-cwin");
  await expect(input).toBeFocused();
  await page.waitForTimeout(400);
  expect(await scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(before - 50);
  await expect(far).toBeInViewport();
  await expect(input).toBeInViewport();

  await input.fill("Still here.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-cw", { hasText: "Still here." })).toBeVisible();
  await page.waitForTimeout(400);
  expect(await scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(before - 50);
  await expect(far).toBeInViewport();
});

test("a comment that arrives in the file is a highlight that opens its thread", async ({ page }) => {
  // A comment written into the file by somebody else (an agent, a
  // collaborator) arrives as one change: its words are highlighted, and a
  // click opens the thread under them.
  await page.goto("/e2e-fixture");
  const line = page.locator(".cm-line", { hasText: "Tenancy is bucket-level" });
  await expect(line).toBeVisible();
  const box = await line.boundingBox();
  if (box === null) throw new Error("no line to click");
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(
    '\n\n<!--c:ab12-->Arrived<!--/c:ab12--> from elsewhere.\n\n```comments\nab12 "Arrived"\n- 2026-09-27T07:30:12Z Codex: This seems a little unprofessional.\n```\n',
  );
  const highlight = page.locator(".cm-cmt-hl", { hasText: "Arrived" });
  await expect(highlight).toBeVisible();
  await highlight.click();
  const card = page.locator(".cm-cw", { hasText: "This seems a little unprofessional" });
  await expect(card).toBeVisible();
  const scroller = await page.locator(".cm-scroller").boundingBox();
  const placed = await card.boundingBox();
  expect(placed!.x + placed!.width).toBeLessThanOrEqual(scroller!.x + scroller!.width);
});

test("Tex answers in the thread and writes its edit straight into the note, which one undo takes back", async ({ page }) => {
  // The whole in-note Tex path in the real app, from the Tex button to undo,
  // against a scripted pretend gateway (`comments/tex/fixtureTransport.ts`)
  // that streams real NDJSON through the real `runNoteRun`.
  await page.goto("/e2e-fixture?tex=fake");
  const line = await selectLine(page, "Tenancy is bucket-level");
  const toolbar = page.locator(".cm-seltool");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.locator("button")).toHaveCount(2);
  await toolbar.getByRole("button", { name: /Ask Tex/ }).click();

  const card = page.locator(".cm-cw");
  const input = card.locator(".cm-cwin");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("@Tex ");
  await input.pressSequentially("add a line after this");
  await page.keyboard.press("Enter");

  // Working, then the addition written into the note: no Keep, no Undo, nothing struck or tinted.
  await expect(card).toContainText("Reading this note");
  await expect(line).toContainText("Added by Tex.", { timeout: 10_000 });
  await expect(card).toContainText("Added it after the highlighted words.");
  await expect(card.getByRole("button", { name: "Keep" })).toHaveCount(0);
  await expect(page.locator(".cm-tex-ins")).toHaveCount(0);
  await expect(page.locator(".cm-tex-del")).toHaveCount(0);
  await expect(page.locator(".cm-content")).not.toContainText("Tex suggests");
  // The added words are the note's own text, not part of the highlight that was tagged.
  await expect(line.locator(".cm-cmt-hl", { hasText: "Added by Tex" })).toHaveCount(0);
  if (process.env.E2E_CSP_NONCE !== "1") await page.screenshot({ path: process.env.TEX_SHOT ?? "test-results/tex-applied.png" });

  // One undo in the editor takes the edit back, with Tex's line in the thread.
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(line).not.toContainText("Added by Tex.");

  // No log of Tex's runs is drawn under the note (Dev2, 2026-11-21 roast): the answer lives in its thread.
  await expect(page.getByTestId("tex-in-note-log")).toHaveCount(0);
});
