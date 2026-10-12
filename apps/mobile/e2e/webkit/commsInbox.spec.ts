import { expect, test, type Page } from "@playwright/test";
import { goHome, settledBox, tapFolderOnHome, tapRow } from "./helpers";

/**
 * The board message's own card, never its thread heading — a thread with one
 * message takes its heading from that message's subject
 * (`groupIntoThreads`), so "Board wants a one-pager" appears twice on screen:
 * once as the thread's name and once as the message's own subject line. Every
 * `MessageCard` carries `data-testid="message-<anchor>"`, so scoping to that
 * pattern is what tells the two apart without the spec needing to know the
 * anchor's actual value.
 */
function boardMessage(page: Page) {
  return page.locator('[data-testid^="message-"]').filter({ hasText: "Board wants a one-pager" });
}

/**
 * The communications console's own walk: Inbox → a channel → a day → an
 * anchor, through the same folder listing every other folder uses, ending on
 * the one message a deep link names; and the contacts folder's A–Z index and
 * a contact page's header.
 *
 * `docs/decisions/testing.md`'s rule for this directory is "reproduced in a
 * real engine, not simulated" — the same reason `editor.spec.ts` exists — and
 * the anchor scroll is exactly that kind of thing: `ChannelDayView` measures
 * a message's real position with `getBoundingClientRect` and calls a real
 * `ScrollView.scrollTo`, neither of which jsdom can do at all — it lays
 * nothing out (`docs/decisions/testing.md` on why WebKit proves the
 * JavaScript engine and jsdom cannot). `commsDay.test.ts` already proves the
 * *data* a day's parts stitch into; this proves the one thing that data
 * cannot: that the message a link names actually ends up on screen.
 *
 * All of it runs on `@seyi`'s fixture tree (`placeholderData.ts`), rendered
 * with the same `renderChannelDayNote`/`renderContactNote` the gateway
 * renders a customer's own mail with — never hand-typed markdown standing in
 * for it.
 */

/** From the fixture's default note, by way of Home, to the Inbox folder. */
async function openInbox(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/e2e-fixture");
  await page.getByTestId("note-scroll").waitFor();
  await goHome(page);
  await tapFolderOnHome(page, "inbox");
}

test("Inbox is an ordinary folder, listing each channel as a folder row", async ({ page }) => {
  await openInbox(page);

  // The same `FolderView` rows as every other folder — no custom Inbox list.
  await page.getByLabel("email, folder").waitFor();
  await expect(page.getByLabel("google-chat, folder")).toBeVisible();
  await expect(page.getByLabel("contacts, folder")).toBeVisible();
  await expect(page.getByTestId("inbox-row")).toHaveCount(0);
});

test("a channel's days, and a day's messages grouped by thread", async ({ page }) => {
  await openInbox(page);
  await tapRow(page, "email");
  await tapRow(page, "name-at-example-com");

  // The mailbox is an ordinary folder listing its two days.
  await tapRow(page, "2026-09-07");

  // The Channel-day view: threads, and a message in each with its sender,
  // subject and body — this is the "day" stop of the walk.
  await page.getByText("Bandshell permit window").first().waitFor();
  await expect(page.getByText("Adam Okonkwo").first()).toBeVisible();
  await expect(page.getByText("rider.pdf", { exact: false })).toBeVisible();

  // The last message on this busy day is not on screen without scrolling —
  // the premise the anchor case below actually tests.
  const board = boardMessage(page);
  await board.first().waitFor();
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("no viewport to compare against");
  const beforeBox = await board.first().boundingBox();
  if (beforeBox === null) throw new Error("the board message has no box");
  expect(beforeBox.y).toBeGreaterThan(viewport.height);
});

/**
 * A screenshot for review, only when asked for (`E2E_SHOTS_DIR`): a picture
 * proves nothing on its own, so CI takes none.
 */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${test.info().project.name}.png` });
}

/** Tap something by test id once its page has stopped sliding in. */
async function tapId(page: Page, testId: string): Promise<void> {
  const box = await settledBox(page.getByTestId(testId));
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test("the contacts folder is an A–Z index, with no chaos chip", async ({ page }) => {
  await openInbox(page);
  await tapRow(page, "contacts");

  const index = page.getByTestId("contacts-index");
  await index.waitFor();
  // Every letter and Other, whether or not there is a folder for it…
  await expect(index.locator('[data-testid^="contacts-letter-"]')).toHaveCount(27);
  // …and the letter folders are not rows as well; the legacy folder still is.
  await expect(page.getByTestId("folder-row").filter({ has: page.getByText("a", { exact: true }) })).toHaveCount(0);
  await expect(page.getByLabel("imessage, folder")).toBeVisible();
  await expect(page.getByTestId("folder-chaos-chip")).toHaveCount(0);
  await snap(page, "contacts-index");

  // A letter opens its folder, as its row would have.
  await tapId(page, "contacts-letter-a");
  await tapRow(page, "adam-okonkwo");

  const header = page.getByTestId("contact-header");
  await header.waitFor();
  await expect(page.getByTestId("contact-header-name")).toHaveText("Adam Okonkwo");
  await expect(header.getByText("Contact", { exact: true })).toBeVisible();
  await expect(page.getByTestId("contact-chip-email")).toContainText("adam@example.net");
  // The Markdown body is still the note, below the header.
  await expect(page.getByText("Production lead for LTN 2026.", { exact: false })).toBeVisible();
  await snap(page, "contact-header");
});

test("an imported iMessage contact gets the same header", async ({ page }) => {
  await openInbox(page);
  await tapRow(page, "contacts");
  await tapRow(page, "imessage");
  await tapRow(page, "sam-reyes");

  await page.getByTestId("contact-header").waitFor();
  await expect(page.getByTestId("contact-header-name")).toHaveText("Sam Reyes");
  await expect(page.getByTestId("contact-chip-imessage")).toContainText("+15550100456");
});

test("a deep link to a message scrolls the channel-day to it", async ({ page }) => {
  // The anchor, read off the screen rather than imported: the board message's
  // card carries it as `message-<anchor>`.
  await openInbox(page);
  await tapRow(page, "email");
  await tapRow(page, "name-at-example-com");
  await tapRow(page, "2026-09-07");
  const testId = await boardMessage(page).first().getAttribute("data-testid");
  if (testId === null) throw new Error("the board message has no test id");
  const anchor = testId.slice("message-".length);

  await page.goto(
    `/e2e-fixture?note=${encodeURIComponent(`0-inbox/email/name-at-example-com/2026/09/2026-09-07.md#${anchor}`)}`,
  );
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("no viewport to compare against");

  const board = boardMessage(page);
  await board.first().waitFor();
  await expect
    .poll(async () => (await board.first().boundingBox())?.y ?? Number.POSITIVE_INFINITY, {
      message: "the linked message should scroll into the visible viewport",
      timeout: 5_000,
    })
    .toBeLessThan(viewport.height);

  const afterBox = await board.first().boundingBox();
  if (afterBox === null) throw new Error("the board message has no box after scrolling");
  expect(afterBox.y).toBeGreaterThanOrEqual(0);

  // Not merely "the page happened to load already showing it" — a real
  // scroll moved the container, from 0 on a fresh mount of the day.
  const scrollTopAfter = await page.getByTestId("channel-day-scroll").evaluate((node) => node.scrollTop);
  expect(scrollTopAfter).toBeGreaterThan(0);
});
