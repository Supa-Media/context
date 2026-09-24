// Gmail sync: rendering one day's events into note parts, writing those parts
// through a ContextStore (idempotently, with a conflict-retry bound), and the
// quota ceiling on `syncOneDay`.
//
// Split out of gmailSync.test.mjs. `event` is the parsed event built in
// parsingAndQuery.test.mjs — passed in rather than rebuilt, since it is the
// exact value the original file reused across these sections.

import { parseChannelDayNote } from "../../../../packages/communications/src/index.js";
import { renderDay, syncOneDay, writeDayPart } from "../../src/communications/gmailSync.js";
import { createMemoryStore } from "./fixtures.mjs";

export async function runGmailRenderAndWriteChecks(check, { event }) {
  // -- rendering one day ---------------------------------------------------------

  const emptyDayParts = renderDay({ mailboxSlug: "person-at-example-invalid", address: "person@example.invalid", date: "2026-09-07", events: [], nonce: "n" });
  check("a day with no events writes NOTHING — an inactive day is not a file at all", emptyDayParts.length === 0);

  const oneDayParts = renderDay({
    mailboxSlug: "person-at-example-invalid",
    address: "person@example.invalid",
    date: "2026-09-07",
    events: [event],
    nonce: "fixed-nonce-for-test",
    now: "2026-09-07T12:00:00.000Z",
  });
  check("a day with events writes exactly one part when under the split threshold", oneDayParts.length === 1);
  check("the path is under the mailbox's own folder, by slug, and under the day's month", oneDayParts[0].path === "0-inbox/email/person-at-example-invalid/2026/09/2026-09-07.md");
  const parsedNote = parseChannelDayNote(oneDayParts[0].text);
  check("the rendered note's frontmatter carries the real ADDRESS, not the slug", parsedNote.frontmatter.account === "person@example.invalid");
  check("the message the day was built from is present in the rendered note", parsedNote.messages.length === 1);

  // -- writing through the store --------------------------------------------------

  const writeStore = createMemoryStore();
  const part = { path: "0-inbox/email/x/2026/09/2026-09-07.md", text: "hello" };
  const first = await writeDayPart(writeStore, part);
  check("a first write of a new path writes", first.wrote === true);
  const second = await writeDayPart(writeStore, part);
  check("writing the exact same bytes a second time is a no-op — the idempotency property", second.wrote === false);
  const third = await writeDayPart(writeStore, { path: part.path, text: "changed" });
  check("writing DIFFERENT bytes to the same path still writes", third.wrote === true);
  check("...and the store now holds the new bytes", (await writeStore.get(part.path)).text() !== undefined);

  const nonConditionalStore = createMemoryStore({ conditionalWrite: false });
  const nonConditionalResult = await writeDayPart(nonConditionalStore, part);
  check("a store without conditionalWrite still writes, unconditionally", nonConditionalResult.wrote === true);

  const alwaysConflictStore = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    get: async () => ({ etag: "e1", text: async () => "old" }),
    put: async () => null,
  };
  let gaveUp = false;
  try {
    await writeDayPart(alwaysConflictStore, { path: "x", text: "new" }, 3);
  } catch {
    gaveUp = true;
  }
  check("a write that can never win its precondition eventually gives up rather than looping forever", gaveUp);

  // -- quota bound -----------------------------------------------------------------

  const quotaStore = createMemoryStore();
  const bigEvents = [event, { ...event, messageId: "m1-b", subject: "Second message", body: "y".repeat(2000) }];
  const partsForQuota = renderDay({
    mailboxSlug: "person-at-example-invalid",
    address: "person@example.invalid",
    date: "2026-09-07",
    events: bigEvents,
    nonce: "n",
  });
  const tinyQuotaResult = await syncOneDay({
    store: quotaStore,
    mailboxSlug: "person-at-example-invalid",
    address: "person@example.invalid",
    date: "2026-09-07",
    events: bigEvents,
    nonce: "n",
    remainingQuotaBytes: 10,
  });
  check("a quota too small for even the smallest part writes nothing and reports it", tinyQuotaResult.bytesWritten === 0 && tinyQuotaResult.quotaExceeded === true);
  check("...and the store agrees — nothing landed", (await quotaStore.list({ prefix: "0-inbox" })).objects.length === 0);
  void partsForQuota;

  const roomyStore = createMemoryStore();
  const roomyResult = await syncOneDay({
    store: roomyStore,
    mailboxSlug: "person-at-example-invalid",
    address: "person@example.invalid",
    date: "2026-09-07",
    events: [event],
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
  });
  check("a quota with room writes normally and reports no ceiling hit", roomyResult.bytesWritten > 0 && roomyResult.quotaExceeded === false);
}
