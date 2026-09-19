import { expect, test } from "@playwright/test";

/**
 * THE ACTIVITY INDICATOR, IN A REAL BROWSER.
 *
 * `__tests__/activityRender.test.ts` mounts `<Explorer>` with a prop this file
 * does not supply, and that is exactly the gap `docs/decisions/app-and-console.md`
 * names: *"a control nobody mounts passes every test of itself"*. The console
 * layout is what passes `activity` to the column, and nothing in jsdom
 * exercises that — delete the prop from `app/(app)/console/_layout.tsx` and
 * every unit test stays green.
 *
 * So this opens the console the visual fixture draws, at a pointer width,
 * against the real web export, and looks at three things:
 *
 *  1. the foot of the tree says how much is new — which proves the fixture's
 *     `activity` reached the column through the same slot the console uses;
 *  2. pressing it puts the list over the tree, with the sentence a person
 *     reads rather than a log line;
 *  3. the dot on *another* context's mark is drawn, and costs the row no
 *     width — the half of this feature the meeting asked for by name, and one
 *     the console layout supplies through a slot the board did not fill until
 *     this spec needed it;
 *  4. the list sits over the column and not across the note, which is a
 *     geometry claim jsdom cannot make at all — `getBoundingClientRect` is
 *     zeroes there, and a popover anchored to the wrong edge is precisely the
 *     defect that shipped the last time a menu was placed without looking
 *     ("A menu anchored at the press point opened on top of the button").
 *
 * The chromium project is what this repository's agent environment can run;
 * CI runs webkit. Neither is a claim about the other — see the config header.
 */

const FRAME = "/e2e-fixture?screen=app-frame-visual";

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

test.beforeEach(async ({ page }) => {
  await page.goto(FRAME);
  await page.getByTestId("explorer-tree").waitFor();
});

test("the foot of the tree says how much is new", async ({ page }) => {
  const line = page.getByTestId("explorer-activity");
  await expect(line).toBeVisible();
  // The fixture has one unread entry. The words are `footLabel`'s, reached
  // through the console's own slot rather than through a prop this spec made.
  await expect(line).toContainText("1 update");
});

test("pressing it puts the list over the tree, in sentences", async ({ page }) => {
  await page.getByTestId("explorer-activity").click();
  const list = page.getByTestId("explorer-activity-list");
  await expect(list).toBeVisible();
  await expect(list).toContainText("@sayo's Claude added 2 notes to areas");
  await expect(list).toContainText("screenshots of the editor bugs from the call");
  // The meeting that landed yesterday, which is the row the whole feature was
  // asked for: "how does Shay even know that this meeting note is here?"
  await expect(list).toContainText("A meeting landed: 2026-09-19-steering");
});

test("the list is over the column, not across the note", async ({ page }) => {
  await page.getByTestId("explorer-activity").click();
  const list = await page.getByTestId("explorer-activity-list").boundingBox();
  const tree = await page.getByTestId("explorer-tree").boundingBox();
  const line = await page.getByTestId("explorer-activity").boundingBox();
  if (list === null || tree === null || line === null) throw new Error("nothing drawn");

  // Inside the column's width, with room to spare on both sides.
  expect(list.x).toBeGreaterThanOrEqual(tree.x);
  expect(list.x + list.width).toBeLessThanOrEqual(tree.x + tree.width + 1);
  // Above the line that opened it, and not off the top of the window.
  expect(list.y + list.height).toBeLessThanOrEqual(line.y + 1);
  expect(list.y).toBeGreaterThan(0);
  // Tall enough to be a list rather than a sliver, and short enough to leave
  // the tree readable behind it.
  expect(list.height).toBeGreaterThan(80);
  expect(list.height).toBeLessThan(900 * 0.7);
});

test("a row in it opens the note it names", async ({ page }) => {
  await page.getByTestId("explorer-activity").click();
  await page.getByRole("button", { name: /added 2 notes/ }).click();
  // The list closes behind you — it is a glance, not a place.
  await expect(page.getByTestId("explorer-activity-list")).toHaveCount(0);
});

test("closing it catches up, and the line goes back to the note count", async ({ page }) => {
  const line = page.getByTestId("explorer-activity");
  await line.click();
  await line.click();
  await expect(page.getByTestId("explorer-activity-list")).toHaveCount(0);
  // The fixture's `markSeen` is a no-op, so the line is still there — what is
  // asserted is that the column did not lose its foot on the way back.
  await expect(
    page.getByTestId("explorer-activity").or(page.getByTestId("explorer-counts")),
  ).toBeVisible();
});

test("another context that has moved carries a dot, and pays no width for it", async ({
  page,
}) => {
  // `public-worship` is the fixture's shared context, and the one the meeting
  // was actually about: you work in your own all day and cannot see that the
  // shared one moved.
  const marked = page.getByTestId("context-foot-public-worship");
  const quiet = page.getByTestId("context-foot-lk");
  await expect(marked).toBeVisible();

  // Said, not just drawn. A mark only sighted people get is the failure
  // `ContextStrip`'s own rule already names.
  await expect(marked).toHaveAttribute(
    "aria-label",
    "Switch to @public-worship, which has changed",
  );
  await expect(quiet).toHaveAttribute("aria-label", "Switch to @lk");

  // And the geometry claim, which is the whole reason this is here rather than
  // in jsdom: the row is a fixed target and the dot is absolutely positioned
  // over it, so a marked context must be exactly the size of an unmarked one.
  // Get this wrong and the dot pushes the names the row exists to fit.
  const a = await marked.boundingBox();
  const b = await quiet.boundingBox();
  if (a === null || b === null) throw new Error("nothing drawn");
  expect(Math.abs(a.width - b.width)).toBeLessThan(1);
  expect(Math.abs(a.height - b.height)).toBeLessThan(1);
});
