// Gmail's first-connect import: the most recent fifty messages, and never a
// window. Owner decision, 2026-10-17 — Tex reads somebody's last fifty emails
// to get to know them — recorded in
// docs/decisions/communications/gmail-and-sync-loop.md, "A first connect reads
// the last fifty messages, and that is not a backfill".
//
// What each check holds, so a sabotage of it has somewhere to fail:
//   - the bound is ONE `messages.list` page of fifty, not a date window;
//   - a day is written whole, from its complete live query, exactly as the
//     forward pass writes it — so the import and a later pass agree byte for
//     byte, and a retry or a reconnect writes nothing new;
//   - the one day that could be partial (the oldest) is written whole or not
//     at all, under a fetch ceiling, never half;
//   - the import reads no history and takes no cursor: the forward pass owns
//     both.

import { parseChannelDayNote } from "../../../../packages/communications/src/index.js";
import {
  RECENT_IMPORT_FETCH_CEILING,
  RECENT_IMPORT_MESSAGES,
  runRecentImport,
  syncDayFromGmail,
} from "../../src/communications/gmailSync.js";
import { createFixtureGmail, createMemoryStore, fixtureMessage } from "./fixtures.mjs";

const SLUG = "p-at-example-invalid";
const DAY_PATH = (date) => `inbox/email/${SLUG}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;

/** `count` messages on `date`, newest first, the order `messages.list` answers in. */
function day(date, count, prefix) {
  return Array.from({ length: count }, (_, index) => {
    return fixtureMessage({
      id: `${prefix}${index}`,
      threadId: `${prefix}t${index}`,
      date: new Date(Date.parse(`${date}T23:00:00.000Z`) - index * 60_000).toISOString(),
      from: "sender@example.invalid",
      to: "p@example.invalid",
      subject: `${prefix} ${index}`,
      text: "x",
    });
  });
}

function options(gmail, store, extra = {}) {
  return {
    store,
    fetchImpl: gmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: SLUG,
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    nonce: "n",
    quotaBytes: 10_000_000,
    ...extra,
  };
}

async function messagesIn(store, date) {
  const object = await store.get(DAY_PATH(date));
  return object === null ? null : parseChannelDayNote(await object.text()).messages.length;
}

export async function runGmailRecentImportChecks(check) {
  check("the first-connect import is fifty messages", RECENT_IMPORT_MESSAGES === 50);
  check("...under a fetch ceiling that is a small multiple of it, not a window", RECENT_IMPORT_FETCH_CEILING === 200);

  // Newest first: 20 today, 20 yesterday, 20 the day before. The fifty most
  // recent end ten messages into the oldest day.
  const mailbox = [
    ...day("2026-10-16", 20, "a"),
    ...day("2026-10-15", 20, "b"),
    ...day("2026-10-14", 20, "c"),
    // Older than anything the fifty reach: never read.
    ...day("2026-09-01", 5, "z"),
  ];
  const gmail = createFixtureGmail({ messages: mailbox });
  const store = createMemoryStore();
  const result = await runRecentImport(options(gmail, store));

  const listCalls = gmail.calls.filter((call) => call.startsWith("/gmail/v1/users/me/messages?"));
  const firstList = new URL(`https://x${listCalls[0]}`).searchParams;
  check("the import asks Gmail for one page of exactly fifty", firstList.get("maxResults") === "50");
  check(
    "...across the connection's folders with Spam and Trash excluded, and no date window",
    firstList.get("q") === "(in:inbox OR in:sent) -in:spam -in:trash",
  );
  check("...and asks for no second page of that list", !listCalls.some((call) => call.includes("pageToken")));

  check("every day the fifty land on is written", (await messagesIn(store, "2026-10-16")) === 20 && (await messagesIn(store, "2026-10-15")) === 20);
  check(
    "THE OLDEST DAY IS WRITTEN WHOLE, not just the ten of its messages inside the fifty",
    (await messagesIn(store, "2026-10-14")) === 20,
  );
  check("mail older than the fifty's oldest day is not read", (await messagesIn(store, "2026-09-01")) === null);
  check("the result counts the days and messages it wrote", result.daysWritten === 3 && result.itemsFound === 60);
  check("...and nothing was skipped", result.daysSkipped === 0 && result.quotaExceeded === false);

  const fetchedIds = gmail.calls
    .filter((call) => /^\/gmail\/v1\/users\/me\/messages\/[^/?]+\?/.test(call))
    .map((call) => call.split("?")[0]);
  check("each message is fetched once, even though it is listed twice", new Set(fetchedIds).size === fetchedIds.length);
  check("...and only messages on the imported days are fetched", fetchedIds.length === 60 && !fetchedIds.some((path) => path.endsWith("/z0")));
  check(
    "the import reads no history and takes no cursor — the forward pass owns both",
    !gmail.calls.some((call) => call.startsWith("/gmail/v1/users/me/history") || call.startsWith("/gmail/v1/users/me/profile")),
  );

  // The same days, written the forward pass's way, are the same bytes.
  const forwardStore = createMemoryStore();
  for (const date of ["2026-10-14", "2026-10-15", "2026-10-16"]) {
    await syncDayFromGmail({ ...options(gmail, forwardStore), date, remainingQuotaBytes: 10_000_000 });
  }
  const notesOf = (target) =>
    [...target._dump()].filter(([key]) => key.startsWith(`inbox/email/`)).map(([key, value]) => [key, value.text]).sort(([a], [b]) => a.localeCompare(b));
  check(
    "an imported day is byte-identical to the same day written by the forward pass",
    JSON.stringify(notesOf(store)) === JSON.stringify(notesOf(forwardStore)),
  );

  const again = await runRecentImport(options(gmail, store));
  check("A RETRY OR A RECONNECT WRITES NOTHING NEW — the days are rebuilt, not appended", again.bytesWritten === 0);
  check("...and duplicates no message", (await messagesIn(store, "2026-10-14")) === 20 && (await messagesIn(store, "2026-10-16")) === 20);

  // The oldest day is the only one the fifty can cut, and it is a firehose:
  // reading it whole would cost far more than fifty. It is skipped, never
  // written half.
  const firehose = createFixtureGmail({
    messages: [...day("2026-10-16", 30, "a"), ...day("2026-10-15", 400, "f")],
  });
  const firehoseStore = createMemoryStore();
  const firehoseResult = await runRecentImport(options(firehose, firehoseStore));
  check("a day too large for the ceiling is skipped, not half-written", (await messagesIn(firehoseStore, "2026-10-15")) === null);
  check("...while the newer whole day is still written", (await messagesIn(firehoseStore, "2026-10-16")) === 30);
  check("...and the skip is reported", firehoseResult.daysSkipped === 1 && firehoseResult.daysWritten === 1);
  const firehoseFetches = firehose.calls.filter((call) => /^\/gmail\/v1\/users\/me\/messages\/[^/?]+\?/.test(call)).length;
  check("...and the import never fetches more than the ceiling", firehoseFetches <= RECENT_IMPORT_FETCH_CEILING);

  const emptyGmail = createFixtureGmail({ messages: [] });
  const emptyStore = createMemoryStore();
  const empty = await runRecentImport(options(emptyGmail, emptyStore));
  check("an empty mailbox imports nothing and writes nothing", empty.itemsFound === 0 && empty.bytesWritten === 0 && emptyStore._dump().size === 0);

  const tiny = await runRecentImport(options(gmail, createMemoryStore(), { quotaBytes: 50 }));
  check("a quota too small for one day stops and says so", tiny.quotaExceeded === true && tiny.daysWritten === 0);

  const spent = await runRecentImport(options(gmail, createMemoryStore(), { bytesAlreadyUsed: 10_000_000 }));
  check("a connection already at its quota reads no message at all", spent.quotaExceeded === true && spent.itemsFound === 0);
}
