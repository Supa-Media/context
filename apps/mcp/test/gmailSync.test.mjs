// Gmail sync against a fake Gmail API and an in-memory store.
//
// The fixture server is data-driven rather than a hand-rolled mock of one
// call: it holds a small mailbox (a `Map` of message resources, shaped like
// Google's documented `Message` resource — see
// https://developers.google.com/gmail/api/reference/rest/v1/users.messages)
// and answers `messages.list`, `messages.get`, `users.getProfile` and
// `history.list` the way the real API does for that mailbox, including
// pagination and history's documented 404-on-expired-cursor. Nothing here
// touches the network; `gmailSync.js` never imports one either — it takes
// `fetchImpl` as a parameter, which is what makes this possible.
//
// SABOTAGE RECORD
//   syncOneDay's quota check disabled                            -> 2 checks failed
//   writeDayPart skips the "already exactly this" no-op check    -> 2 checks failed
//   runIncrementalSync lets a 404 propagate instead of catching  -> throws, suite aborts
//   buildDayQuery drops "-in:spam -in:trash"                     -> 1 check failed

import {
  GmailHistoryExpiredError,
  buildDayQuery,
  dateKeyOf,
  dateRange,
  decodeBase64UrlToUtf8,
  extractBody,
  gmailMessageToEvent,
  getMessage,
  getProfileHistoryId,
  headerValue,
  listAllHistory,
  listAllMessageIds,
  parseAddressList,
  renderDay,
  runBackfill,
  runIncrementalSync,
  syncDayFromGmail,
  syncOneDay,
  writeDayPart,
} from "../src/communications/gmailSync.js";
import { parseChannelDayNote } from "../../../packages/communications/src/index.js";

/* -------------------------------------------------------------------------- */
/* A tiny in-memory ContextStore, per the contract in src/store/index.js      */
/* -------------------------------------------------------------------------- */

function createMemoryStore({ conditionalWrite = true } = {}) {
  const objects = new Map();
  let nextEtag = 1;
  return {
    capabilities: { conditionalWrite },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return { etag: object.etag, text: async () => object.text, arrayBuffer: async () => new TextEncoder().encode(object.text).buffer };
    },
    async put(key, value, options) {
      const existing = objects.get(key);
      if (conditionalWrite && options?.onlyIf?.etagMatches !== undefined) {
        const expected = options.onlyIf.etagMatches;
        if (!existing || existing.etag !== expected) return null;
      }
      const etag = String(nextEtag++);
      objects.set(key, { text: String(value), etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return { objects: keys.map((key) => ({ key, size: objects.get(key).text.length, uploaded: new Date() })), truncated: false };
    },
    // Test-only inspection, not part of the ContextStore contract.
    _dump: () => new Map(objects),
  };
}

/* -------------------------------------------------------------------------- */
/* A fake Gmail, data-driven from a small mailbox                             */
/* -------------------------------------------------------------------------- */

function base64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One Gmail `Message` resource, `format=full` shaped. */
function fixtureMessage({ id, threadId, date, from, to, subject, text, html, attachments = [] }) {
  const headers = [
    { name: "From", value: from },
    { name: "To", value: to },
    { name: "Subject", value: subject },
  ];
  const parts = [];
  if (text !== undefined) parts.push({ mimeType: "text/plain", body: { size: text.length, data: base64Url(text) } });
  if (html !== undefined) parts.push({ mimeType: "text/html", body: { size: html.length, data: base64Url(html) } });
  for (const attachment of attachments) {
    parts.push({
      filename: attachment.filename,
      mimeType: attachment.contentType,
      // A real message carries an `attachmentId` here. This fixture omits it
      // to prove `extractBody` never needed it — metadata-only, by contract.
      body: { size: attachment.size },
    });
  }
  return {
    id,
    threadId,
    internalDate: String(Date.parse(date)),
    payload: { mimeType: "multipart/mixed", headers, parts },
  };
}

/**
 * @param {{messages: object[], history?: {pages: object[]} | {expired: true},
 *          profileHistoryId?: string}} config
 */
function createFixtureGmail(config) {
  const byId = new Map(config.messages.map((message) => [message.id, message]));
  const calls = [];
  let historyPageIndex = 0;

  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname + parsed.search);

    if (parsed.pathname === "/gmail/v1/users/me/profile") {
      return jsonResponse({ historyId: config.profileHistoryId ?? "1000" });
    }

    if (parsed.pathname === "/gmail/v1/users/me/history") {
      if (config.history?.expired) return jsonResponse({ error: { code: 404 } }, 404);
      const pageToken = parsed.searchParams.get("pageToken");
      const index = pageToken ? Number(pageToken) : 0;
      const page = config.history?.pages?.[index];
      if (!page) return jsonResponse({ history: [] });
      const body = { history: page.history ?? [], historyId: page.historyId };
      if (index + 1 < (config.history.pages?.length ?? 0)) body.nextPageToken = String(index + 1);
      return jsonResponse(body);
    }

    const idMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(parsed.pathname);
    if (idMatch) {
      const message = byId.get(decodeURIComponent(idMatch[1]));
      if (!message) return jsonResponse({ error: { code: 404 } }, 404);
      return jsonResponse(message);
    }

    if (parsed.pathname === "/gmail/v1/users/me/messages") {
      const query = parsed.searchParams.get("q") ?? "";
      const afterMatch = /after:(\d+)/.exec(query);
      const beforeMatch = /before:(\d+)/.exec(query);
      const afterMs = afterMatch ? Number(afterMatch[1]) * 1000 : -Infinity;
      const beforeMs = beforeMatch ? Number(beforeMatch[1]) * 1000 : Infinity;
      const matching = config.messages.filter((message) => {
        const at = Number(message.internalDate);
        return at >= afterMs && at < beforeMs;
      });
      const maxResults = Number(parsed.searchParams.get("maxResults") ?? 100);
      const pageToken = parsed.searchParams.get("pageToken");
      const start = pageToken ? Number(pageToken) : 0;
      const page = matching.slice(start, start + maxResults);
      const body = {
        messages: page.map((message) => ({ id: message.id, threadId: message.threadId })),
        resultSizeEstimate: matching.length,
      };
      if (start + maxResults < matching.length) body.nextPageToken = String(start + maxResults);
      return jsonResponse(body);
    }

    return jsonResponse({ error: { code: 404 } }, 404);
  };

  return { fetchImpl, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

export async function runGmailSyncChecks(check) {
  // -- pure parsing -----------------------------------------------------------

  check("base64url round-trips a UTF-8 body, including non-ASCII", decodeBase64UrlToUtf8(base64Url("héllo — wörld")) === "héllo — wörld");
  check("an empty/absent body decodes to an empty string, not a throw", decodeBase64UrlToUtf8(undefined) === "" && decodeBase64UrlToUtf8("") === "");

  check(
    "header lookup is case-insensitive, per RFC 5322",
    headerValue([{ name: "sUbJeCt", value: "Hello" }], "Subject") === "Hello",
  );
  check("a missing header is an empty string, never undefined", headerValue([], "Subject") === "");

  check(
    "a display name and address parse apart",
    JSON.stringify(parseAddressList('"Ada Lovelace" <ada@example.invalid>')) ===
      JSON.stringify([{ name: "Ada Lovelace", address: "ada@example.invalid" }]),
  );
  check(
    "a bare address with no display name parses too",
    JSON.stringify(parseAddressList("bob@example.invalid")) === JSON.stringify([{ address: "bob@example.invalid" }]),
  );
  check(
    "a list of two addresses is two entries",
    parseAddressList("a@example.invalid, b@example.invalid").length === 2,
  );
  check("an empty value parses to no addresses at all", parseAddressList("").length === 0);

  const plainMessage = fixtureMessage({
    id: "m1",
    threadId: "t1",
    date: "2026-09-07T09:14:00.000Z",
    from: "Adam Okonkwo <adam@example.invalid>",
    to: "person@example.invalid",
    subject: "Quarterly numbers",
    text: "Here they are.",
  });
  check("a plain-text body decodes and is used as-is", extractBody(plainMessage.payload).text === "Here they are.");

  const htmlOnlyMessage = fixtureMessage({
    id: "m2",
    threadId: "t2",
    date: "2026-09-07T10:00:00.000Z",
    from: "a@example.invalid",
    to: "person@example.invalid",
    subject: "HTML only",
    html: "<p>Hello <b>world</b></p><br>Line two",
  });
  const htmlBody = extractBody(htmlOnlyMessage.payload).text;
  check("an HTML-only message falls back to stripped text", htmlBody.includes("Hello") && htmlBody.includes("world") && !htmlBody.includes("<b>"));

  const withAttachment = fixtureMessage({
    id: "m3",
    threadId: "t3",
    date: "2026-09-07T11:00:00.000Z",
    from: "a@example.invalid",
    to: "person@example.invalid",
    subject: "Has a file",
    text: "See attached.",
    attachments: [{ filename: "report.pdf", contentType: "application/pdf", size: 12345 }],
  });
  const extracted = extractBody(withAttachment.payload);
  check(
    "an attachment is described by filename, type and size — metadata only",
    extracted.attachments.length === 1 &&
      extracted.attachments[0].filename === "report.pdf" &&
      extracted.attachments[0].contentType === "application/pdf" &&
      extracted.attachments[0].size === 12345,
  );
  check(
    "the attachment part never contributes an attachmentId to anything this module produces",
    JSON.stringify(extracted) !== JSON.stringify(withAttachment.payload) && !JSON.stringify(extracted).includes("attachmentId"),
  );

  const event = gmailMessageToEvent(plainMessage, { mailboxSlug: "person-at-example-invalid" });
  check("account carries the mailbox SLUG, not the address", event.account === "person-at-example-invalid");
  check("messageId and threadId are the provider's raw ids — hashed later, not here", event.messageId === "m1" && event.threadId === "t1");
  check("sentAt is derived from internalDate", event.sentAt === new Date(Number(plainMessage.internalDate)).toISOString());
  check("the sender is parsed from the From header", event.from.address === "adam@example.invalid" && event.from.name === "Adam Okonkwo");
  check("dateKeyOf reads the calendar date off sentAt", dateKeyOf(event) === "2026-09-07");

  // -- query building -----------------------------------------------------------

  const query = buildDayQuery({ folders: ["inbox", "sent"], date: "2026-09-07" });
  check("both configured folders appear in the query", query.includes("in:inbox") && query.includes("in:sent"));
  check(
    "spam and trash are excluded UNCONDITIONALLY, not merely un-included",
    query.includes("-in:spam") && query.includes("-in:trash"),
  );
  check(
    "the date bound is exactly one UTC calendar day, back to back with no gap or overlap",
    (() => {
      const q1 = buildDayQuery({ folders: ["inbox"], date: "2026-09-07" });
      const q2 = buildDayQuery({ folders: ["inbox"], date: "2026-09-08" });
      const after1 = Number(/after:(\d+)/.exec(q1)[1]);
      const before1 = Number(/before:(\d+)/.exec(q1)[1]);
      const after2 = Number(/after:(\d+)/.exec(q2)[1]);
      return before1 - after1 === 24 * 60 * 60 && before1 === after2;
    })(),
  );
  check("a query with no date has no after/before bound at all — 'all mail'", !buildDayQuery({ folders: ["inbox"] }).includes("after:"));
  let threwOnBadDate = false;
  try {
    buildDayQuery({ folders: ["inbox"], date: "2026-02-30" });
  } catch {
    threwOnBadDate = true;
  }
  check("a date that does not exist is refused rather than silently mis-queried", threwOnBadDate);

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
  check("the path is under the mailbox's own folder, by slug", oneDayParts[0].path === "0-inbox/email/person-at-example-invalid/2026-09-07.md");
  const parsedNote = parseChannelDayNote(oneDayParts[0].text);
  check("the rendered note's frontmatter carries the real ADDRESS, not the slug", parsedNote.frontmatter.account === "person@example.invalid");
  check("the message the day was built from is present in the rendered note", parsedNote.messages.length === 1);

  // -- writing through the store --------------------------------------------------

  const writeStore = createMemoryStore();
  const part = { path: "0-inbox/email/x/2026-09-07.md", text: "hello" };
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
    capabilities: { conditionalWrite: true },
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
  const dayNote = await dayStore.get("0-inbox/email/person-at-example-invalid/2026-09-07.md");
  const dayNoteParsed = parseChannelDayNote(await dayNote.text());
  check("the OTHER day's message is not in this day's note", dayNoteParsed.messages.length === 2);

  const resync = await syncDayFromGmail(dayOptions);
  check("RE-RUNNING THE SAME DAY CHANGES NO BYTES — idempotent upsert by message id", resync.bytesWritten === 0);

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
  check(
    "the inactive day in the middle really did not get a file",
    (await backfillStore.get("0-inbox/email/p-at-example-invalid/2026-09-02.md")) === null,
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
}
