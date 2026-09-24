// Gmail sync: the raw REST calls (messages.list pagination, messages.get,
// getProfileHistoryId, history.list) against the fixture server, including
// history's truncation and idempotency guarantees.
//
// Split out of gmailSync.test.mjs; see fixtures.mjs for the fixture server.

import { GmailHistoryExpiredError, getMessage, getProfileHistoryId, listAllHistory, listAllMessageIds, runIncrementalSync, writeDayPart } from "../../src/communications/gmailSync.js";
import { createFixtureGmail, createMemoryStore, fixtureMessage } from "./fixtures.mjs";

export async function runGmailRestCallsChecks(check) {
  // -- Gmail REST calls, against the fixture server ------------------------------

  const manyMessages = Array.from({ length: 5 }, (_, index) =>
    fixtureMessage({
      id: `page-${index}`,
      threadId: `thread-${index}`,
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "person@example.invalid",
      subject: `Message ${index}`,
      text: "x",
    }),
  );
  const paged = createFixtureGmail({ messages: manyMessages });
  const ids = await listAllMessageIds({ fetchImpl: paged.fetchImpl, accessToken: "tok", query: "in:inbox", maxResults: 2 });
  check("pagination across messages.list is fully followed", ids.length === 5);
  check("every id shows up exactly once — no duplicate, no drop, across page boundaries", new Set(ids).size === 5);

  const fetchedFull = await getMessage({ fetchImpl: paged.fetchImpl, accessToken: "tok", id: "page-2" });
  check("getMessage fetches the full, not-a-summary shape", fetchedFull.payload?.parts?.length > 0);

  const profileGmail = createFixtureGmail({ messages: [], profileHistoryId: "9999" });
  check(
    "getProfileHistoryId reads the mailbox's current cursor",
    (await getProfileHistoryId({ fetchImpl: profileGmail.fetchImpl, accessToken: "tok" })) === "9999",
  );

  const expiredGmail = createFixtureGmail({ messages: [], history: { expired: true } });
  let threwExpired = false;
  try {
    await listAllHistory({ fetchImpl: expiredGmail.fetchImpl, accessToken: "tok", startHistoryId: "1" });
  } catch (error) {
    threwExpired = error instanceof GmailHistoryExpiredError;
  }
  check("a 404 on history.list is a typed, catchable gap signal", threwExpired);

  const historyGmail = createFixtureGmail({
    messages: [],
    history: {
      pages: [
        { history: [{ messagesAdded: [{ message: { id: "h1" } }] }], historyId: "1500" },
        { history: [{ messagesAdded: [{ message: { id: "h2" } }] }], historyId: "1600" },
      ],
    },
  });
  const historyResult = await listAllHistory({ fetchImpl: historyGmail.fetchImpl, accessToken: "tok", startHistoryId: "1000" });
  check("history.list pagination is followed and every added id collected", historyResult.messageIds.has("h1") && historyResult.messageIds.has("h2"));
  check("the cursor advances to the LAST page's historyId", historyResult.historyId === "1600");

  /*
    A WALK THAT RAN OUT OF PAGES MUST SAY SO, AND MUST NOT HAND BACK THE HEAD.

    `history.list` returns the MAILBOX'S CURRENT `historyId` on every page, not
    a per-page cursor. So a walk that stops at `maxPages` and reports that value
    is reporting "you are caught up" while holding only the first N pages —
    everything after them is skipped forever, silently, with no gap signalled.
    A mailbox that has been quiet for weeks and then gets a first pass is
    exactly where this bites.

    What it hands back instead is the last *history record's* own id, which is
    a valid `startHistoryId` for the next call and covers precisely the records
    this walk actually collected. That is what makes a truncated pass make
    progress rather than repeating itself.
  */
  /*
    IDEMPOTENCE IS NOT A PROPERTY OF R2. It has to hold on the backends this
    repository already says cannot do a conditional write, because a loop that
    runs every few minutes against one of those is where rewriting an unchanged
    day forever actually costs somebody money.
  */
  const plainStore = createMemoryStore({ conditionalWrite: false });
  const plainPart = {
    path: "0-inbox/email/person-at-example-invalid/2026/09/2026-09-07.md",
    text: "# a day\n",
  };
  const firstPlainWrite = await writeDayPart(plainStore, plainPart);
  const secondPlainWrite = await writeDayPart(plainStore, plainPart);
  check("a first write lands on a store with no conditional write", firstPlainWrite.wrote === true);
  check(
    "...and re-writing the identical day there writes nothing, same as on R2",
    secondPlainWrite.wrote === false,
  );

  const truncatedGmail = createFixtureGmail({
    messages: [],
    history: {
      pages: [
        { history: [{ id: "1100", messagesAdded: [{ message: { id: "t1" } }] }], historyId: "9999" },
        { history: [{ id: "1200", messagesAdded: [{ message: { id: "t2" } }] }], historyId: "9999" },
        { history: [{ id: "1300", messagesAdded: [{ message: { id: "t3" } }] }], historyId: "9999" },
      ],
    },
  });
  const truncatedResult = await listAllHistory({
    fetchImpl: truncatedGmail.fetchImpl,
    accessToken: "tok",
    startHistoryId: "1000",
    maxPages: 2,
  });
  check("a history walk that hit its page limit reports truncation", truncatedResult.truncated === true);
  check(
    "...and hands back the last record it actually walked, never the mailbox head",
    truncatedResult.lastRecordId === "1200" && truncatedResult.historyId === "9999",
  );
  check(
    "...having collected only the ids from the pages it did walk",
    truncatedResult.messageIds.has("t1") &&
      truncatedResult.messageIds.has("t2") &&
      !truncatedResult.messageIds.has("t3"),
  );

  const untruncatedResult = await listAllHistory({
    fetchImpl: truncatedGmail.fetchImpl,
    accessToken: "tok",
    startHistoryId: "1000",
    maxPages: 50,
  });
  check("a walk that reached the end reports no truncation", untruncatedResult.truncated === false);
  check("...and only then is the mailbox head the right place to resume", untruncatedResult.historyId === "9999");

  const truncatedSyncGmail = createFixtureGmail({
    messages: [],
    history: {
      pages: [
        { history: [{ id: "1100", messagesAdded: [] }], historyId: "9999" },
        { history: [{ id: "1200", messagesAdded: [] }], historyId: "9999" },
        { history: [{ id: "1300", messagesAdded: [] }], historyId: "9999" },
      ],
    },
  });
  const truncatedSync = await runIncrementalSync({
    store: createMemoryStore(),
    fetchImpl: truncatedSyncGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "person-at-example-invalid",
    address: "person@example.invalid",
    folders: ["inbox"],
    startHistoryId: "1000",
    nonce: "n",
    quotaBytes: 1_000_000,
    maxHistoryPages: 2,
  });
  check("an incremental sync tells its caller the walk was truncated", truncatedSync.truncated === true);
  check(
    "...and offers the record boundary as the cursor rather than the head",
    truncatedSync.historyId === "1200",
  );
}
