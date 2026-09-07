import { expect, test, type Page } from "@playwright/test";
import { tap } from "./helpers";

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
 * anchor, ending on the one message a contact's activity link names.
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

/** From the fixture's default note to the context's root folder listing. */
async function openContextRoot(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/e2e-fixture");
  await page.getByTestId("note-scroll").waitFor();
  await tap(page, "@seyi, the context you are in — open its root");
  await page.getByTestId("folder-row").first().waitFor();
}

test("Inbox lists every connected channel, most recently active first", async ({ page }) => {
  await openContextRoot(page);
  await tap(page, "0-inbox, folder");

  await expect(page.getByTestId("inbox-row")).toHaveCount(3);
  await expect(page.getByText("Google Chat", { exact: true })).toBeVisible();
  await expect(page.getByText("Contacts", { exact: true })).toBeVisible();
  // The mailbox has no address read yet on the Inbox row by design — see
  // `inbox.ts`'s `channelLabel` — so it is labelled by its folder slug here.
  await expect(page.getByText("name-at-example-com", { exact: true })).toBeVisible();
});

test("a channel's days, and a day's messages grouped by thread", async ({ page }) => {
  await openContextRoot(page);
  await tap(page, "0-inbox, folder");
  await tap(page, "name-at-example-com, last active 2026-09-07");

  // The Channel view: both of the mailbox's days, newest first, and the
  // mailbox's real address — read off its own most recent day, not the slug.
  await expect(page.getByText("name@example.com", { exact: true })).toBeVisible();
  await expect(page.getByTestId("channel-day-row")).toHaveCount(2);

  await tap(page, "2026-09-07");

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

test("following a contact's activity link scrolls the channel-day to that message", async ({
  page,
}) => {
  await openContextRoot(page);
  await tap(page, "0-inbox, folder");
  await tap(page, "Contacts, last active 2026-09-07");

  // The generic folder listing — Contacts is not a channel view of its own,
  // see `paths.ts`'s own comment on why — showing the one contact page.
  await tap(page, "adam-okonkwo");

  // The Contact page: identifiers, and one activity link into the day the
  // board message landed on.
  await page.getByText("Adam Okonkwo", { exact: true }).first().waitFor();
  await expect(page.getByText("adam@example.net", { exact: false })).toBeVisible();
  const activity = page.getByTestId("contact-activity-row");
  await expect(activity).toHaveCount(1);

  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("no viewport to compare against");

  await tap(page, "2026-09-07: Board wants a one-pager");

  // Landed back on the channel-day view, scrolled to the message the link
  // named — the "anchor" stop of the walk, and the one a scroll target
  // proves rather than a data shape.
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
  // scroll actually moved the container. This is a fresh mount of the
  // channel-day view (a fresh `select`), so `scrollTop` starts at 0 before
  // `ChannelDayView`'s own effect runs; anything above 0 is that effect
  // having acted, not a coincidence of layout.
  const scrollTopAfter = await page.getByTestId("channel-day-scroll").evaluate((node) => node.scrollTop);
  expect(scrollTopAfter).toBeGreaterThan(0);
});
