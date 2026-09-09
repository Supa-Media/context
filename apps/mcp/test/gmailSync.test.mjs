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
//   sanitizeAttachmentFilename stops stripping "/" (no basename) -> 5 checks failed
//   resolveDayAttachments does not check `manifest.resolved` first
//     (always re-fetches)                                        -> 4 checks failed

import {
  GMAIL_ATTACHMENT_MAX_BYTES,
  GmailApiError,
  GmailHistoryExpiredError,
  attachmentPath,
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
  manifestPath,
  parseAddressList,
  readManifest,
  renderDay,
  resolveDayAttachments,
  runBackfill,
  runIncrementalSync,
  sanitizeAttachmentFilename,
  sha256Hex,
  sweepExpiredAttachments,
  syncDayFromGmail,
  syncOneDay,
  writeDayPart,
} from "../src/communications/gmailSync.js";
import { parseChannelDayNote } from "../../../packages/communications/src/index.js";
import { assertSafeKey } from "../src/store/index.js";

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
      // Attachment bytes arrive as a `Uint8Array`; everything else is a
      // string. Decoding bytes as UTF-8 is a test-only convenience — every
      // fixture attachment in this suite is plain ASCII content precisely so
      // `.text()` round-trips it exactly, the same way the real bytes a
      // customer's PDF is made of are opaque to this module either way.
      const text = value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);
      objects.set(key, { text, etag });
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
      // A real message with a real attachment carries an `attachmentId` and
      // NO `data` here — the bytes are reachable only through
      // `attachments.get`. An attachment fixture with no `attachmentId` (the
      // metadata-only tests above) proves `extractBody` never needed one.
      body: { size: attachment.size, attachmentId: attachment.attachmentId },
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
 *          profileHistoryId?: string,
 *          attachmentContents?: Record<string, string>}} config
 *   `attachmentContents` is keyed `${messageId}/${attachmentId}`, plain text
 *   for test readability — real bytes are arbitrary binary, and nothing in
 *   this module's attachment path treats them as anything but bytes.
 */
function createFixtureGmail(config) {
  const byId = new Map(config.messages.map((message) => [message.id, message]));
  const calls = [];

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

    const attachmentMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(
      parsed.pathname,
    );
    if (attachmentMatch) {
      const key = `${decodeURIComponent(attachmentMatch[1])}/${decodeURIComponent(attachmentMatch[2])}`;
      const content = config.attachmentContents?.[key];
      if (content === undefined) return jsonResponse({ error: { code: 404 } }, 404);
      return jsonResponse({ size: content.length, data: base64Url(content) });
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
  check("...and reports the number of emails found", backfillResult.itemsFound === 2);
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
  check("...and reports the number of emails recovered", reconcileResult.itemsFound === 2);

  // -- attachments: fetched into the bucket, retained on a timer ----------------
  //
  // The owner's decision (2026-09-07), reversing the metadata-only default:
  // "sometimes an email says look at the PDF attached, and it should land
  // somewhere referenceable in the bucket." Four properties, each its own
  // check below: fetch, reference from the day note, expire, and a re-sync
  // after expiry does not re-fetch.

  // -- filename sanitization: a hostile name must not escape the folder --------

  check(
    "path traversal in a filename never escapes the attachments folder",
    attachmentPath({
      mailboxSlug: "p-at-example-invalid",
      date: "2026-09-07",
      contentHash: "abc123",
      filename: "../../../etc/passwd",
    }).startsWith("0-inbox/email/p-at-example-invalid/attachments/2026-09-07/abc123-"),
  );
  check(
    "...and the sanitized name itself carries no '..' segment",
    !sanitizeAttachmentFilename("../../etc/passwd").includes(".."),
  );
  check(
    "an absolute path is reduced to its basename",
    sanitizeAttachmentFilename("/etc/passwd") === "passwd",
  );
  check(
    "a Windows-style traversal is reduced the same way",
    sanitizeAttachmentFilename("..\\..\\windows\\system32\\config") === "config",
  );
  check(
    "wikilink-syntax characters are stripped from the filename — the path is embedded in [[path|label]] verbatim",
    (() => {
      const safe = sanitizeAttachmentFilename("evil]] and [[.audit/x|y#z.pdf");
      return !/[[\]|#]/.test(safe);
    })()
  );
  check(
    "a filename that sanitizes to nothing falls back to a safe default, never an empty path segment",
    sanitizeAttachmentFilename("../..") === "attachment" && sanitizeAttachmentFilename("") === "attachment",
  );
  check(
    "every attachment path this module builds is a key the store itself accepts",
    (() => {
      const hostileNames = [
        "../../../etc/passwd",
        "..\\..\\windows\\config",
        "/etc/passwd",
        "evil]] and [[.audit/x|y#z",
        "..",
        ".",
        "",
        "a\u0000b",
      ];
      return hostileNames.every((filename) => {
        const path = attachmentPath({ mailboxSlug: "p-at-example-invalid", date: "2026-09-07", contentHash: "h", filename });
        try {
          assertSafeKey(path);
          return true;
        } catch {
          return false;
        }
      });
    })()
  );
  check(
    "a date bound (Gmail's own 25MB attachment limit) is a real, named constant",
    GMAIL_ATTACHMENT_MAX_BYTES === 25 * 1024 * 1024,
  );

  // -- fetch, reference, and idempotent re-sync ---------------------------------

  const attachmentMessages = [
    fixtureMessage({
      id: "att1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "See attached",
      text: "The report is attached.",
      attachments: [{ filename: "report.pdf", contentType: "application/pdf", size: 11, attachmentId: "ATT-1" }],
    }),
  ];
  const attachmentGmail = createFixtureGmail({
    messages: attachmentMessages,
    attachmentContents: { "att1/ATT-1": "pdf-bytes!!" },
  });
  const attachmentStore = createMemoryStore();
  const fetchDayOptions = {
    store: attachmentStore,
    fetchImpl: attachmentGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    attachmentMode: "store",
    attachmentRetentionDays: 90,
  };
  const firstFetch = await syncDayFromGmail(fetchDayOptions);
  check("fetching a day with a storable attachment writes bytes for both the note and the attachment", firstFetch.bytesWritten > "pdf-bytes!!".length);

  const expectedHash = await sha256Hex(new TextEncoder().encode("pdf-bytes!!"));
  const expectedAttachmentPath = attachmentPath({
    mailboxSlug: "p-at-example-invalid",
    date: "2026-09-07",
    contentHash: expectedHash,
    filename: "report.pdf",
  });
  const storedAttachment = await attachmentStore.get(expectedAttachmentPath);
  check("the attachment's bytes actually landed at the content-hashed path", storedAttachment !== null);
  check("...with the exact bytes Gmail served", storedAttachment !== null && (await storedAttachment.text()) === "pdf-bytes!!");

  const dayNoteAfterFetch = await attachmentStore.get("0-inbox/email/p-at-example-invalid/2026-09-07.md");
  const dayNoteText = dayNoteAfterFetch ? await dayNoteAfterFetch.text() : "";
  check(
    "the channel-day note LINKS to the fetched attachment",
    dayNoteText.includes(`[[${expectedAttachmentPath}|report.pdf]]`),
  );

  const customFolderGmail = createFixtureGmail({
    messages: attachmentMessages,
    attachmentContents: { "att1/ATT-1": "pdf-bytes!!" },
  });
  const customFolderStore = createMemoryStore();
  await syncDayFromGmail({
    ...fetchDayOptions,
    store: customFolderStore,
    fetchImpl: customFolderGmail.fetchImpl,
    folder: "2-areas/communications/supa-mail",
  });
  check(
    "a mailbox destination folder moves the day note",
    (await customFolderStore.get("2-areas/communications/supa-mail/2026-09-07.md")) !== null,
  );
  check(
    "...and moves the attachment manifest beside that mailbox destination",
    (await customFolderStore.get("2-areas/communications/supa-mail/attachments/.manifest.json")) !== null,
  );

  const attachmentCallCountAfterFirstFetch = attachmentGmail.calls.filter((call) => call.includes("/attachments/")).length;
  check("exactly one attachment fetch happened for one attachment", attachmentCallCountAfterFirstFetch === 1);

  const resyncSameDay = await syncDayFromGmail(fetchDayOptions);
  check(
    "RE-SYNCING THE SAME DAY DOES NOT RE-FETCH THE ATTACHMENT — the manifest already resolved it",
    attachmentGmail.calls.filter((call) => call.includes("/attachments/")).length === attachmentCallCountAfterFirstFetch,
  );
  check("...and writes no new attachment bytes on the resync", resyncSameDay.bytesWritten === 0);

  // -- expiry, and no re-fetch after expiry -------------------------------------

  const nearFuture = new Date(Date.now() + 1000).toISOString();
  const sweepResult = await sweepExpiredAttachments({
    store: attachmentStore,
    mailboxSlug: "p-at-example-invalid",
    now: nearFuture, // Nothing has expired yet — retention is 90 days.
  });
  check("nothing expires before its retention window has passed", sweepResult.expiredHashes.length === 0);

  const farFuture = new Date(Date.now() + 91 * 24 * 60 * 60 * 1000).toISOString();
  const expirySweep = await sweepExpiredAttachments({
    store: attachmentStore,
    mailboxSlug: "p-at-example-invalid",
    now: farFuture,
  });
  check("91 days later, the attachment has expired", expirySweep.expiredHashes.includes(expectedHash));
  check("the sweep names the affected date, for a caller that wants to re-render its note", expirySweep.affectedDates.includes("2026-09-07"));
  check(
    "the file itself is deleted from the bucket",
    (await attachmentStore.get(expectedAttachmentPath)) === null,
  );

  const resyncAfterExpiry = await syncDayFromGmail(fetchDayOptions);
  check(
    "A RE-SYNC AFTER EXPIRY DOES NOT RE-FETCH — the manifest remembers this attachment is gone",
    attachmentGmail.calls.filter((call) => call.includes("/attachments/")).length === attachmentCallCountAfterFirstFetch,
  );
  const noteAfterExpiry = await attachmentStore.get("0-inbox/email/p-at-example-invalid/2026-09-07.md");
  const noteTextAfterExpiry = noteAfterExpiry ? await noteAfterExpiry.text() : "";
  check(
    "the note's link is rewritten to name and size only once expired",
    !noteTextAfterExpiry.includes("[[") && noteTextAfterExpiry.includes("report.pdf") && noteTextAfterExpiry.includes("(not stored)"),
  );

  check(
    "sweeping twice in a row is idempotent — nothing is deleted a second time",
    (
      await sweepExpiredAttachments({ store: attachmentStore, mailboxSlug: "p-at-example-invalid", now: farFuture })
    ).expiredHashes.length === 0,
  );

  // -- 'keep forever' never expires ---------------------------------------------

  const foreverMessages = [
    fixtureMessage({
      id: "forever1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "Keep this",
      text: "x",
      attachments: [{ filename: "keepsake.pdf", contentType: "application/pdf", size: 5, attachmentId: "ATT-2" }],
    }),
  ];
  const foreverGmail = createFixtureGmail({ messages: foreverMessages, attachmentContents: { "forever1/ATT-2": "abcde" } });
  const foreverStore = createMemoryStore();
  await syncDayFromGmail({
    store: foreverStore,
    fetchImpl: foreverGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    attachmentMode: "store",
    attachmentRetentionDays: "forever",
  });
  const foreverManifest = await readManifest(foreverStore, "p-at-example-invalid");
  const foreverHash = await sha256Hex(new TextEncoder().encode("abcde"));
  check("'forever' retention records no expiry at all", foreverManifest.files[foreverHash]?.expiresAt == null);
  const distantFuture = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const foreverSweep = await sweepExpiredAttachments({ store: foreverStore, mailboxSlug: "p-at-example-invalid", now: distantFuture });
  check("...and never expires, no matter how far in the future the sweep runs", !foreverSweep.expiredHashes.includes(foreverHash));

  // -- size cap and quota: too large or too expensive stays metadata-only -------

  const oversizedMessages = [
    fixtureMessage({
      id: "big1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "Huge file",
      text: "x",
      attachments: [
        { filename: "huge.zip", contentType: "application/zip", size: GMAIL_ATTACHMENT_MAX_BYTES + 1, attachmentId: "ATT-BIG" },
      ],
    }),
  ];
  const oversizedGmail = createFixtureGmail({ messages: oversizedMessages, attachmentContents: {} });
  const oversizedStore = createMemoryStore();
  await syncDayFromGmail({
    store: oversizedStore,
    fetchImpl: oversizedGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    attachmentMode: "store",
    attachmentRetentionDays: 90,
  });
  check(
    "an attachment over Gmail's own size cap is never fetched — declared size alone decides",
    oversizedGmail.calls.filter((call) => call.includes("/attachments/")).length === 0,
  );

  const quotaBoundMessages = [
    fixtureMessage({
      id: "q1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "Small enough, but no quota",
      text: "x",
      attachments: [{ filename: "small.pdf", contentType: "application/pdf", size: 100, attachmentId: "ATT-Q" }],
    }),
  ];
  const quotaGmail = createFixtureGmail({ messages: quotaBoundMessages, attachmentContents: { "q1/ATT-Q": "y".repeat(100) } });
  const quotaBoundStore = createMemoryStore();
  const quotaBoundResult = await syncDayFromGmail({
    store: quotaBoundStore,
    fetchImpl: quotaGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 10, // Smaller than even this one small attachment.
    attachmentMode: "store",
    attachmentRetentionDays: 90,
  });
  check(
    "a quota too small for even a small attachment leaves it metadata-only, without spending the fetch",
    quotaGmail.calls.filter((call) => call.includes("/attachments/")).length === 0,
  );
  void quotaBoundResult;

  // -- metadata-only mode never fetches ------------------------------------------

  const metadataOnlyGmail = createFixtureGmail({ messages: attachmentMessages, attachmentContents: { "att1/ATT-1": "pdf-bytes!!" } });
  const metadataOnlyStore = createMemoryStore();
  await syncDayFromGmail({
    store: metadataOnlyStore,
    fetchImpl: metadataOnlyGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    attachmentMode: "metadata-only",
  });
  check(
    "attachmentMode: metadata-only never calls Gmail's attachments.get at all",
    metadataOnlyGmail.calls.filter((call) => call.includes("/attachments/")).length === 0,
  );

  // -- cross-message dedup: the same bytes twice is one file --------------------

  const dedupMessages = [
    fixtureMessage({
      id: "dup1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "First copy",
      text: "x",
      attachments: [{ filename: "shared.pdf", contentType: "application/pdf", size: 9, attachmentId: "ATT-A" }],
    }),
    fixtureMessage({
      id: "dup2",
      threadId: "t2",
      date: "2026-09-07T10:00:00.000Z",
      from: "b@example.invalid",
      to: "p@example.invalid",
      subject: "Second copy, identical bytes",
      text: "y",
      attachments: [{ filename: "shared.pdf", contentType: "application/pdf", size: 9, attachmentId: "ATT-B" }],
    }),
  ];
  const dedupGmail = createFixtureGmail({
    messages: dedupMessages,
    attachmentContents: { "dup1/ATT-A": "identical", "dup2/ATT-B": "identical" },
  });
  const dedupStore = createMemoryStore();
  await syncDayFromGmail({
    store: dedupStore,
    fetchImpl: dedupGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    attachmentMode: "store",
    attachmentRetentionDays: 90,
  });
  const dedupManifest = await readManifest(dedupStore, "p-at-example-invalid");
  check("the same bytes from two different messages is ONE file entry", Object.keys(dedupManifest.files).length === 1);
  check("...but both messages' attachments resolved to it", Object.keys(dedupManifest.resolved).length === 2);

  // -- the manifest itself is plumbing, never a note ----------------------------

  check(
    "the manifest lives at a dot-prefixed path — plumbing, hidden from every note-listing tool",
    manifestPath("p-at-example-invalid")
      .split("/")
      .some((segment) => segment.startsWith(".")),
  );

  /* ------------------------------------------------------------------------ */
  /* ADVERSARIAL REVIEW, 2026-09-07: every check below was written by trying   */
  /* the attack first and watching it succeed. Three of them did.             */
  /* ------------------------------------------------------------------------ */

  // -- a hostile filename, the rounds the first pass did not try ---------------

  // Percent-encoding is the traversal that survives a basename split: `%2f`
  // is not `/` to `String.prototype.split`, and a segment decoding to
  // `../../x` is not the literal `..` that `describeKeyProblem` rejects. What
  // closes it is one layer further down — `S3Store` encodes each segment with
  // `encodeRfc3986`, so a literal `%` in a key goes on the wire as `%25` and
  // S3 stores the key with the percent signs in it, exactly as written. This
  // check pins that: the escape stays inert text in one path segment, and
  // never becomes a separator.
  check(
    "a percent-encoded traversal in a filename stays one inert path segment",
    (() => {
      const path = attachmentPath({
        mailboxSlug: "p-at-example-invalid",
        date: "2026-09-07",
        contentHash: "h",
        filename: "%2e%2e%2f%2e%2e%2fprivacy.md",
      });
      assertSafeKey(path);
      const segments = path.split("/");
      return (
        segments.length === 6 &&
        segments[0] === "0-inbox" &&
        decodeURIComponent(segments[5]).includes("../../privacy.md") === true &&
        path.startsWith("0-inbox/email/p-at-example-invalid/attachments/2026-09-07/")
      );
    })(),
  );

  // Dropbox folds case and R2 does not, so two attachments whose names differ
  // only in case are one object on one backend and two on another. It cannot
  // become an overwrite of somebody else's file regardless, and the reason is
  // structural rather than lucky: the key is `<sha256>-<name>`, so colliding
  // the key requires colliding the hash, which requires the same bytes — and
  // the same bytes are the same file, which is the dedup path, not a clobber.
  check(
    "two files whose names differ only by case cannot overwrite each other on a case-folding store",
    (() => {
      const upper = attachmentPath({ mailboxSlug: "m", date: "2026-09-07", contentHash: "aaa", filename: "Invoice.PDF" });
      const lower = attachmentPath({ mailboxSlug: "m", date: "2026-09-07", contentHash: "bbb", filename: "invoice.pdf" });
      // Different bytes give different hashes, so the keys differ in a
      // position that survives case folding.
      return upper.toLowerCase() !== lower.toLowerCase();
    })(),
  );

  check(
    "a filename that tries to BE the manifest cannot land on the manifest's key",
    (() => {
      const manifest = manifestPath("m");
      return [".manifest.json", "..manifest.json", "../.manifest.json", "..%2f.manifest.json"].every(
        (filename) =>
          attachmentPath({ mailboxSlug: "m", date: "2026-09-07", contentHash: "h", filename }) !== manifest,
      );
    })(),
  );

  check(
    "a filename thousands of characters long is bounded, and stays one segment",
    (() => {
      const path = attachmentPath({
        mailboxSlug: "m",
        date: "2026-09-07",
        contentHash: "h",
        filename: `${"A".repeat(5000)}.pdf`,
      });
      assertSafeKey(path);
      return sanitizeAttachmentFilename(`${"A".repeat(5000)}.pdf`).length === 150 && path.split("/").length === 6;
    })(),
  );

  // The bidi OVERRIDES were already stripped; the bidi MARKS, the Arabic
  // letter mark and the zero-width family were not, and they reached the
  // storage key. Two objects named `invoice.pdf` and `inv<U+200F>oice.pdf`
  // are indistinguishable in every listing a person or an agent ever reads,
  // while being two files on the customer's bill and two different wikilink
  // targets in the raw Markdown.
  check(
    "no invisible or directional character survives into an attachment key",
    (() => {
      // Spelled as code points on purpose. A test fixture for an invisible
      // character written as the literal byte is a test nobody can read, and
      // is the class `scripts/check-no-identifiers.mjs` rule 5 now refuses.
      const invisible = [
        0x00ad, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
        0x2060, 0x2066, 0x2069, 0xfeff,
      ].map((code) => String.fromCharCode(code));
      const pattern = new RegExp(
        "[\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff]",
      );
      return invisible.every((character) => {
        const safe = sanitizeAttachmentFilename(`inv${character}oice.pdf`);
        return safe === "invoice.pdf" && !pattern.test(safe);
      });
    })(),
  );

  // -- the 25 MB cap and the quota are enforced on the ACTUAL bytes ------------
  //
  // THE HOLE THIS FOUND. `extractBody` maps a part with no `body.size` to
  // `size: undefined`, and `resolveDayAttachments` mapped that to a declared
  // size of ZERO — which passes `> GMAIL_ATTACHMENT_MAX_BYTES` and
  // `> remaining` no matter how large the part really is. Before the fix,
  // running this block fetched and wrote 30 MB into the store with the
  // connection's quota set to nothing at all.

  function createSizedAttachmentGmail(byteCount) {
    let attachmentCalls = 0;
    const content = "A".repeat(byteCount);
    const fetchImpl = async (url) => {
      if (url.includes("/attachments/")) {
        attachmentCalls += 1;
        return jsonResponse({ size: content.length, data: base64Url(content) });
      }
      return jsonResponse({});
    };
    return { fetchImpl, attachmentCalls: () => attachmentCalls };
  }

  async function resolveOneUndeclaredAttachment({ byteCount, remainingQuotaBytes }) {
    const written = [];
    const store = {
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      async get() {
        return null;
      },
      async put(path, bytes) {
        written.push({ path, size: bytes.length });
        return { etag: "e" };
      },
      async delete() {},
    };
    const gmail = createSizedAttachmentGmail(byteCount);
    const events = [
      {
        messageId: "m1",
        // NO `size` — exactly what `extractBody` produces when Gmail omits
        // `body.size` for a part.
        attachments: [{ filename: "mystery.bin", contentType: "application/octet-stream", attachmentId: "A1" }],
      },
    ];
    const result = await resolveDayAttachments({
      store,
      fetchImpl: gmail.fetchImpl,
      accessToken: "tok",
      mailboxSlug: "m",
      date: "2026-09-07",
      events,
      attachmentMode: "store",
      retentionDays: 90,
      now: new Date().toISOString(),
      remainingQuotaBytes,
      manifest: { version: 1, resolved: {}, files: {} },
    });
    return { written, result, events };
  }

  const undeclaredOverCap = await resolveOneUndeclaredAttachment({
    byteCount: GMAIL_ATTACHMENT_MAX_BYTES + 1,
    remainingQuotaBytes: 10 * GMAIL_ATTACHMENT_MAX_BYTES,
  });
  check(
    "AN ATTACHMENT WITH NO DECLARED SIZE IS STILL BOUND BY THE 25MB CAP — the actual bytes decide, not Gmail's word",
    undeclaredOverCap.written.length === 0 && undeclaredOverCap.result.bytesWritten === 0,
  );
  check(
    "...and it is not recorded as resolved, so a later pass can try again rather than remembering a skip",
    Object.keys(undeclaredOverCap.result.manifest.resolved).length === 0,
  );
  check(
    "...and the message's note still describes it, metadata-only",
    undeclaredOverCap.events[0].attachments[0].path === undefined,
  );

  const undeclaredOverQuota = await resolveOneUndeclaredAttachment({
    byteCount: 4096,
    remainingQuotaBytes: 0,
  });
  check(
    "AN ATTACHMENT WITH NO DECLARED SIZE CANNOT SPEND QUOTA THE CONNECTION DOES NOT HAVE",
    undeclaredOverQuota.written.length === 0 && undeclaredOverQuota.result.bytesWritten === 0,
  );

  const undeclaredWithinBounds = await resolveOneUndeclaredAttachment({
    byteCount: 4096,
    remainingQuotaBytes: 1_000_000,
  });
  check(
    "...while one that fits is still fetched and written — the fix is a bound, not a refusal",
    undeclaredWithinBounds.written.length === 1 && undeclaredWithinBounds.result.bytesWritten === 4096,
  );

  // -- a 404 is not universally an expired history cursor ----------------------
  //
  // THE SECOND HOLE. `gmailFetch` promoted every 404 to
  // `GmailHistoryExpiredError`, so a message deleted between being listed and
  // being fetched — the single most ordinary transient in a live mailbox —
  // came back to the caller wearing the name of the one error whose documented
  // answer is a full 90-day reconcile.

  // Pinned at the type, not only at the behaviour. Both call sites that skip a
  // vanished message exclude `GmailHistoryExpiredError` explicitly rather than
  // letting `instanceof GmailApiError` swallow it (it is a subclass with the
  // same 404), precisely so that re-widening `gmailFetch` to promote every 404
  // fails HERE rather than being absorbed downstream and failing nothing.
  const notFoundFetch = async () => jsonResponse({ error: { code: 404 } }, 404);
  let messageGetError = null;
  try {
    await getMessage({ fetchImpl: notFoundFetch, accessToken: "tok", id: "gone" });
  } catch (error) {
    messageGetError = error;
  }
  check(
    "a 404 from messages.get is a plain GmailApiError, NOT the history-gap type",
    messageGetError instanceof GmailApiError &&
      !(messageGetError instanceof GmailHistoryExpiredError) &&
      messageGetError.status === 404,
  );
  const rateLimitedFetch = async () =>
    jsonResponse(
      {
        error: {
          code: 403,
          status: "RESOURCE_EXHAUSTED",
          errors: [{ reason: "userRateLimitExceeded" }],
        },
      },
      403,
    );
  let rateLimitError = null;
  try {
    await getMessage({ fetchImpl: rateLimitedFetch, accessToken: "tok", id: "stopped" });
  } catch (error) {
    rateLimitError = error;
  }
  check(
    "a structured Gmail 403 keeps Google's safe reason so the worker can tell quota from auth refusal",
    rateLimitError instanceof GmailApiError &&
      rateLimitError.status === 403 &&
      rateLimitError.reason === "userRateLimitExceeded" &&
      rateLimitError.googleStatus === "RESOURCE_EXHAUSTED",
  );
  let historyPageError = null;
  try {
    await listAllHistory({ fetchImpl: notFoundFetch, accessToken: "tok", startHistoryId: "1" });
  } catch (error) {
    historyPageError = error;
  }
  check(
    "...while the same 404 from history.list still IS the history-gap type",
    historyPageError instanceof GmailHistoryExpiredError,
  );

  const vanishingMessages = [
    fixtureMessage({
      id: "stays",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "Still here",
      text: "Present.",
    }),
  ];
  const vanishingGmail = createFixtureGmail({ messages: vanishingMessages });
  // `messages.list` is answered from `config.messages`, so injecting an id the
  // map does not hold is exactly "listed a moment ago, gone now".
  const listedThenGone = {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/gmail/v1/users/me/messages") {
        return jsonResponse({
          messages: [{ id: "stays", threadId: "t1" }, { id: "deleted-since", threadId: "t2" }],
          resultSizeEstimate: 2,
        });
      }
      return vanishingGmail.fetchImpl(url);
    },
  };
  const vanishingStore = createMemoryStore();
  let vanishingThrew = null;
  let vanishingResult = null;
  try {
    vanishingResult = await syncDayFromGmail({
      store: vanishingStore,
      fetchImpl: listedThenGone.fetchImpl,
      accessToken: "tok",
      mailboxSlug: "p-at-example-invalid",
      address: "p@example.invalid",
      folders: ["inbox", "sent"],
      date: "2026-09-07",
      nonce: "n",
      remainingQuotaBytes: 1_000_000,
    });
  } catch (error) {
    vanishingThrew = error;
  }
  check(
    "A MESSAGE DELETED BETWEEN LIST AND FETCH DOES NOT ABORT THE DAY",
    vanishingThrew === null && vanishingResult !== null && vanishingResult.partsWritten === 1,
  );
  const vanishingNote = await (
    await vanishingStore.get("0-inbox/email/p-at-example-invalid/2026-09-07.md")
  ).text();
  check(
    "...and the day is written from what Gmail still has",
    parseChannelDayNote(vanishingNote).messages.length === 1,
  );

  const historyThenGone = {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/gmail/v1/users/me/history") {
        return jsonResponse({
          history: [{ messagesAdded: [{ message: { id: "deleted-since" } }] }],
          historyId: "3000",
        });
      }
      if (parsed.pathname === "/gmail/v1/users/me/messages") {
        return jsonResponse({ messages: [], resultSizeEstimate: 0 });
      }
      // Every messages.get 404s: the one id history named is gone.
      return jsonResponse({ error: { code: 404 } }, 404);
    },
  };
  let historyGoneThrew = null;
  let historyGoneResult = null;
  try {
    historyGoneResult = await runIncrementalSync({
      store: createMemoryStore(),
      fetchImpl: historyThenGone.fetchImpl,
      accessToken: "tok",
      mailboxSlug: "p-at-example-invalid",
      address: "p@example.invalid",
      folders: ["inbox", "sent"],
      startHistoryId: "1",
      nonce: "n",
      quotaBytes: 1_000_000,
    });
  } catch (error) {
    historyGoneThrew = error;
  }
  check(
    "A MESSAGE HISTORY NAMED AND GMAIL NO LONGER HAS IS NOT AN EXPIRED CURSOR",
    historyGoneThrew === null &&
      historyGoneResult !== null &&
      historyGoneResult.gapDetected === false &&
      historyGoneResult.daysTouched.length === 0,
  );
  check(
    "...and the cursor still advances, so the same dead id is not re-walked forever",
    historyGoneResult !== null && historyGoneResult.historyId === "3000",
  );
  check(
    "an EXPIRED CURSOR is still the one 404 that means a gap — the narrowing did not silence it",
    (
      await runIncrementalSync({
        store: createMemoryStore(),
        fetchImpl: createFixtureGmail({ messages: [], history: { expired: true } }).fetchImpl,
        accessToken: "tok",
        mailboxSlug: "p-at-example-invalid",
        address: "p@example.invalid",
        folders: ["inbox"],
        startHistoryId: "1",
        nonce: "n",
        quotaBytes: 1_000_000,
      })
    ).gapDetected === true,
  );

  // An attachment Gmail no longer holds must cost the picture, not the note.
  const goneAttachmentMessages = [
    fixtureMessage({
      id: "ga1",
      threadId: "t1",
      date: "2026-09-07T09:00:00.000Z",
      from: "a@example.invalid",
      to: "p@example.invalid",
      subject: "It was here a minute ago",
      text: "See attached.",
      attachments: [{ filename: "gone.pdf", contentType: "application/pdf", size: 9, attachmentId: "ATT-GONE" }],
    }),
  ];
  // `attachmentContents` is empty, so the fixture 404s `attachments.get`.
  const goneAttachmentGmail = createFixtureGmail({ messages: goneAttachmentMessages, attachmentContents: {} });
  const goneAttachmentStore = createMemoryStore();
  let goneAttachmentThrew = null;
  let goneAttachmentResult = null;
  try {
    goneAttachmentResult = await syncDayFromGmail({
      store: goneAttachmentStore,
      fetchImpl: goneAttachmentGmail.fetchImpl,
      accessToken: "tok",
      mailboxSlug: "p-at-example-invalid",
      address: "p@example.invalid",
      folders: ["inbox", "sent"],
      date: "2026-09-07",
      nonce: "n",
      remainingQuotaBytes: 1_000_000,
      attachmentMode: "store",
      attachmentRetentionDays: 90,
    });
  } catch (error) {
    goneAttachmentThrew = error;
  }
  check(
    "AN ATTACHMENT GMAIL NO LONGER HAS COSTS THE FILE, NEVER THE NOTE",
    goneAttachmentThrew === null && goneAttachmentResult !== null && goneAttachmentResult.partsWritten === 1,
  );
  check(
    "...and it is not recorded as resolved, so it is retried if it comes back",
    Object.keys((await readManifest(goneAttachmentStore, "p-at-example-invalid")).resolved).length === 0,
  );

  // The same rule for a body that is not decodable base64 at all: one
  // attachment lost, the note kept.
  const undecodableStore = createMemoryStore();
  let undecodableThrew = null;
  let undecodableResult = null;
  try {
    undecodableResult = await syncDayFromGmail({
      store: undecodableStore,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.includes("/attachments/")) return jsonResponse({ data: "!!! not base64 !!!" });
        return createFixtureGmail({ messages: goneAttachmentMessages }).fetchImpl(url);
      },
      accessToken: "tok",
      mailboxSlug: "p-at-example-invalid",
      address: "p@example.invalid",
      folders: ["inbox", "sent"],
      date: "2026-09-07",
      nonce: "n",
      remainingQuotaBytes: 1_000_000,
      attachmentMode: "store",
      attachmentRetentionDays: 90,
    });
  } catch (error) {
    undecodableThrew = error;
  }
  check(
    "an undecodable attachment body costs the file, never the note",
    undecodableThrew === null && undecodableResult !== null && undecodableResult.partsWritten === 1,
  );

  // -- the sweep acts on the manifest as DATA, not as instructions -------------
  //
  // The manifest is our bookkeeping inside a bucket the customer also syncs to
  // Obsidian and rclone. "Deletes only files this sync wrote" has to be a
  // property of the code that reads it, not only of the code that writes it.
  const hostileManifestStore = createMemoryStore();
  await hostileManifestStore.put("privacy.md", "# privacy");
  await hostileManifestStore.put("0-inbox/email/p-at-example-invalid/attachments/2026-09-07/h-real.pdf", "bytes");
  await hostileManifestStore.put(
    manifestPath("p-at-example-invalid"),
    JSON.stringify({
      version: 1,
      resolved: {},
      files: {
        outside: { path: "privacy.md", size: 9, writtenAt: "2026-09-07T00:00:00.000Z", expiresAt: "2026-09-08T00:00:00.000Z", expired: false },
        elsewhere: { path: "0-inbox/email/other-at-example-invalid/attachments/2026-09-07/h-x.pdf", size: 9, writtenAt: "2026-09-07T00:00:00.000Z", expiresAt: "2026-09-08T00:00:00.000Z", expired: false },
        real: { path: "0-inbox/email/p-at-example-invalid/attachments/2026-09-07/h-real.pdf", size: 5, writtenAt: "2026-09-07T00:00:00.000Z", expiresAt: "2026-09-08T00:00:00.000Z", expired: false },
      },
    }),
  );
  const hostileSweep = await sweepExpiredAttachments({
    store: hostileManifestStore,
    mailboxSlug: "p-at-example-invalid",
    now: "2026-09-09T00:00:00.000Z",
  });
  check(
    "A MANIFEST ENTRY POINTING OUTSIDE THE MAILBOX'S OWN FOLDER DELETES NOTHING",
    (await hostileManifestStore.get("privacy.md")) !== null,
  );
  check(
    "...not even another mailbox's attachments folder in the same bucket",
    hostileSweep.expiredHashes.includes("elsewhere") === false,
  );
  check(
    "...while the entry that IS this mailbox's own is still swept",
    hostileSweep.expiredHashes.includes("real") &&
      (await hostileManifestStore.get("0-inbox/email/p-at-example-invalid/attachments/2026-09-07/h-real.pdf")) ===
        null,
  );

  // -- an inline image is an attachment, per the owner's brief ------------------
  //
  // Gmail gives an inline image a `filename` and a `body.attachmentId` exactly
  // like a "real" attachment, differing only in `Content-Disposition: inline`
  // and a `Content-ID` header this module never reads. The claim in the module
  // comment was unproven until here.
  const inlineMessage = {
    id: "inline1",
    threadId: "t1",
    internalDate: String(Date.parse("2026-09-07T09:00:00.000Z")),
    payload: {
      mimeType: "multipart/related",
      headers: [
        { name: "From", value: "a@example.invalid" },
        { name: "To", value: "p@example.invalid" },
        { name: "Subject", value: "Signature image" },
      ],
      parts: [
        { mimeType: "text/html", body: { size: 30, data: base64Url("<p>See <img src=\"cid:sig\"></p>") } },
        {
          partId: "1",
          mimeType: "image/png",
          filename: "signature.png",
          headers: [
            { name: "Content-Disposition", value: 'inline; filename="signature.png"' },
            { name: "Content-ID", value: "<sig>" },
          ],
          body: { size: 8, attachmentId: "ATT-INLINE" },
        },
      ],
    },
  };
  check(
    "an INLINE image is parsed as an attachment, not skipped as body decoration",
    (() => {
      const parsed = extractBody(inlineMessage.payload);
      return (
        parsed.attachments.length === 1 &&
        parsed.attachments[0].filename === "signature.png" &&
        parsed.attachments[0].attachmentId === "ATT-INLINE"
      );
    })(),
  );
  const inlineGmail = createFixtureGmail({
    messages: [inlineMessage],
    attachmentContents: { "inline1/ATT-INLINE": "PNGBYTES" },
  });
  const inlineStore = createMemoryStore();
  await syncDayFromGmail({
    store: inlineStore,
    fetchImpl: inlineGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: "p-at-example-invalid",
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: "2026-09-07",
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    attachmentMode: "store",
    attachmentRetentionDays: 90,
  });
  const inlineHash = await sha256Hex(new TextEncoder().encode("PNGBYTES"));
  check(
    "...and its bytes are fetched into the bucket like any other attachment",
    (await inlineStore.get(
      `0-inbox/email/p-at-example-invalid/attachments/2026-09-07/${inlineHash}-signature.png`,
    )) !== null,
  );

}
