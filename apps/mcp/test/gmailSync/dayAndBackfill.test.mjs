// Gmail sync: one full day end to end (organic contact creation, idempotent
// re-sync, the legacy flat-file day format), backfill across a window
// (quota-bound), and incremental sync's gap detection plus full reconcile.
//
// Split out of gmailSync.test.mjs; see fixtures.mjs for the fixture server.

import { parseChannelDayNote } from "../../../../packages/communications/src/index.js";
import { dateRange, runBackfill, runIncrementalSync, syncDayFromGmail } from "../../src/communications/gmailSync.js";
import { createFixtureGmail, createMemoryStore, fixtureMessage } from "./fixtures.mjs";

export async function runGmailDayAndBackfillChecks(check) {
  // -- one full day end to end, and idempotent re-sync -----------------------------

  const dayMessages = [
    fixtureMessage({ id: "d1", threadId: "t1", date: "2026-09-07T09:00:00.000Z", from: "a@example.invalid", to: "person@example.invalid", subject: "One", text: "first" }),
    fixtureMessage({ id: "d2", threadId: "t2", date: "2026-09-07T15:00:00.000Z", from: "b@example.invalid", to: "person@example.invalid", subject: "Two", text: "second" }),
    // A different day — must NOT show up when syncing 2026-09-07.
    fixtureMessage({ id: "d3", threadId: "t3", date: "2026-09-08T09:00:00.000Z", from: "c@example.invalid", to: "person@example.invalid", subject: "Three", text: "third" }),
  ];
  const dayGmail = createFixtureGmail({ messages: dayMessages });
  const dayStore = createMemoryStore();
  const dayOptions = {
    store: dayStore,
    fetchImpl: dayGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "person-at-example-invalid",
    address: "person@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
  };
  const firstSync = await syncDayFromGmail(dayOptions);
  check("syncing a day writes exactly the messages that landed that day", firstSync.partsWritten === 1 && firstSync.bytesWritten > 0);
  const dayNote = await dayStore.get("0-inbox/email/person-at-example-invalid/2026/09/2026-09-07.md");
  const dayNoteParsed = parseChannelDayNote(await dayNote.text());
  check("the OTHER day's message is not in this day's note", dayNoteParsed.messages.length === 2);
  const contactPaths = (await dayStore.list({ prefix: "0-inbox/contacts/" })).objects.map((item) => item.key);
  check("Gmail sync organically creates one contact per correspondent", contactPaths.length === 2);
  const firstContact = await dayStore.get(contactPaths[0]);
  check("a Gmail-derived contact links to its daily note and never copies the message body", (await firstContact.text()).includes("[[0-inbox/email/person-at-example-invalid/2026/09/2026-09-07#msg-") && !(await firstContact.text()).includes("\nfirst\n"));

  const resync = await syncDayFromGmail(dayOptions);
  check("RE-RUNNING THE SAME DAY CHANGES NO BYTES — idempotent upsert by message id", resync.bytesWritten === 0);

  /*
    A BUCKET SYNCED BEFORE THE DATED TREE, SYNCED AGAIN AFTER IT.

    The dated tree is forward-only, so a day whose note is already flat has to
    go on being that note. Written end to end rather than only against
    `placeDayParts` because the failure this guards is not a wrong return
    value, it is a day that quietly exists twice — the flat copy frozen at
    whatever the last pass before the deploy wrote, the dated copy growing,
    and both parsing as 2026-09-07.
  */
  const legacyStore = createMemoryStore();
  const legacyPath = "0-inbox/email/person-at-example-invalid/2026-09-07.md";
  await legacyStore.put(legacyPath, "---\ntype: channel-day\n---\n\n# 2026-09-07\n");
  const legacySync = await syncDayFromGmail({ ...dayOptions, store: legacyStore });
  check("a day already filed flat is written flat, not moved into the tree", legacySync.partsWritten === 1);
  check(
    "...so the day exists once, where it always was",
    (await legacyStore.get(legacyPath)) !== null &&
      (await legacyStore.get("0-inbox/email/person-at-example-invalid/2026/09/2026-09-07.md")) === null,
  );
  check(
    "...and it is the day's real messages that landed in it, not the placeholder",
    parseChannelDayNote(await (await legacyStore.get(legacyPath)).text()).messages.length === 2,
  );
  await syncDayFromGmail({ ...dayOptions, store: legacyStore, date: "2026-09-08" });
  check(
    "...while a day the same bucket has NOT seen is filed under its month — the switch is per day, not per bucket",
    (await legacyStore.get("0-inbox/email/person-at-example-invalid/2026/09/2026-09-08.md")) !== null,
  );

  // -- backfill across a window, quota-bound ----------------------------------------

  const backfillMessages = [
    fixtureMessage({ id: "b1", threadId: "t1", date: "2026-09-01T09:00:00.000Z", from: "a@example.invalid", to: "p@example.invalid", subject: "Day 1", text: "x" }),
    fixtureMessage({ id: "b2", threadId: "t2", date: "2026-09-03T09:00:00.000Z", from: "a@example.invalid", to: "p@example.invalid", subject: "Day 3", text: "x" }),
    // 2026-09-02 has no mail at all.
  ];
  const backfillGmail = createFixtureGmail({ messages: backfillMessages });
  const backfillStore = createMemoryStore();
  const backfillResult = await runBackfill({
    store: backfillStore,
    fetchImpl: backfillGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    startDate: "2026-09-01",
    endDate: "2026-09-03",
    nonce: "n",
    quotaBytes: 1_000_000,
  });
  check("backfill processes every day in the window, active or not", backfillResult.daysProcessed === 3);
  check("...but only writes a note for the days that actually had mail", backfillResult.daysWithMail === 2);
  check("...and reports the number of emails found", backfillResult.itemsFound === 2);
  check(
    "the inactive day in the middle really did not get a file",
    (await backfillStore.get("0-inbox/email/p-at-example-invalid/2026/09/2026-09-02.md")) === null,
  );

  const tinyBackfillStore = createMemoryStore();
  const tinyBackfillResult = await runBackfill({
    store: tinyBackfillStore,
    fetchImpl: backfillGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    startDate: "2026-09-01",
    endDate: "2026-09-03",
    nonce: "n",
    quotaBytes: 50, // Smaller than even one rendered day.
  });
  check("a quota too small to finish the window stops early and says so", tinyBackfillResult.quotaExceeded === true && tinyBackfillResult.daysProcessed < 3);

  check("dateRange is inclusive of both ends", JSON.stringify(dateRange("2026-08-30", "2026-09-01")) === JSON.stringify(["2026-08-30", "2026-08-31", "2026-09-01"]));

  // -- incremental sync: gap detection and full reconcile ---------------------------

  const incrementalMessages = [
    fixtureMessage({ id: "i1", threadId: "t1", date: "2026-09-05T09:00:00.000Z", from: "a@example.invalid", to: "p@example.invalid", subject: "Five", text: "x" }),
    fixtureMessage({ id: "i2", threadId: "t2", date: "2026-09-06T09:00:00.000Z", from: "a@example.invalid", to: "p@example.invalid", subject: "Six", text: "x" }),
  ];
  const incrementalGmail = createFixtureGmail({
    messages: incrementalMessages,
    history: {
      pages: [{ history: [{ messagesAdded: [{ message: { id: "i1" } }, { message: { id: "i2" } }] }], historyId: "2000" }],
    },
  });
  const incrementalStore = createMemoryStore();
  const incrementalResult = await runIncrementalSync({
    store: incrementalStore,
    fetchImpl: incrementalGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    startHistoryId: "1000",
    nonce: "n",
    quotaBytes: 1_000_000,
  });
  check("incremental sync touches exactly the days a changed message landed on", JSON.stringify(incrementalResult.daysTouched) === JSON.stringify(["2026-09-05", "2026-09-06"]));
  check("the cursor advances to what Gmail returned", incrementalResult.historyId === "2000");
  check("no gap on a normal page", incrementalResult.gapDetected === false);

  const gapGmail = createFixtureGmail({ messages: [], history: { expired: true } });
  const gapResult = await runIncrementalSync({
    store: createMemoryStore(),
    fetchImpl: gapGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    startHistoryId: "1",
    nonce: "n",
    quotaBytes: 1_000_000,
  });
  check("a 404 surfaces as gapDetected, not as a thrown error the caller must catch", gapResult.gapDetected === true);
  check("nothing is written when a gap is detected — the caller reconciles via a full backfill instead", gapResult.daysTouched.length === 0 && gapResult.bytesWritten === 0);

  const emptyHistoryGmail = createFixtureGmail({ messages: [], history: { pages: [{ history: [], historyId: "1050" }] } });
  const emptyHistoryResult = await runIncrementalSync({
    store: createMemoryStore(),
    fetchImpl: emptyHistoryGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    startHistoryId: "1000",
    nonce: "n",
    quotaBytes: 1_000_000,
  });
  check("no new mail is a normal, empty answer — not a gap", emptyHistoryResult.gapDetected === false && emptyHistoryResult.daysTouched.length === 0);

  const emptyPagedHistory = createFixtureGmail({
    messages: [],
    history: { pages: Array.from({ length: 51 }, () => ({ historyId: "999999" })) },
  });
  const emptyPagedResult = await runIncrementalSync({
    store: createMemoryStore(),
    fetchImpl: emptyPagedHistory.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    startHistoryId: "1000",
    nonce: "n",
    quotaBytes: 1_000_000,
  });
  check("a truncated history walk with no record ids has no safe resume cursor", emptyPagedResult.truncated === true && emptyPagedResult.historyId === undefined);

  // Full reconcile: after a gap, the documented fallback is `runBackfill` over
  // the connection's window — prove it actually recovers the messages a
  // reconcile exists to catch.
  const reconcileStore = createMemoryStore();
  const reconcileResult = await runBackfill({
    store: reconcileStore,
    fetchImpl: incrementalGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    startDate: "2026-09-05",
    endDate: "2026-09-06",
    nonce: "n",
    quotaBytes: 1_000_000,
  });
  check("a full reconcile after a gap recovers every day in the window", reconcileResult.daysWithMail === 2);
  check("...and reports the number of emails recovered", reconcileResult.itemsFound === 2);
}
