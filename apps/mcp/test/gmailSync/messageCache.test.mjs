// What a pass asks Gmail for, after Google rate-limited a busy mailbox
// (2026-10-18). Recorded in docs/decisions/communications/gmail-and-sync-loop.md,
// "A pass fetches only the mail it has not seen".
//
// What each check holds, so a sabotage of it has somewhere to fail:
//   - a day's second pass fetches only the message it has not seen, and still
//     writes exactly the bytes a pass with no cache writes;
//   - a message dropped from the day's list is dropped from the note;
//   - a cache that cannot be trusted is ignored, never believed;
//   - an incremental pass fetches each new message once, not twice;
//   - a draft, spam or archived message in history costs nothing;
//   - Google's "slow down" is retried, its "out for the day" is not;
//   - a day Google stops part-way keeps what it fetched, so the retry resumes.
//
// SABOTAGE RECORD
//   syncDayFromGmail ignores the cache (always fetches)          -> 2 checks failed
//   cache keeps events the day's list no longer names           -> 1 check failed
//   readDayCache ignores the version                            -> 1 check failed
//   runIncrementalSync stops passing `known`                    -> 1 check failed
//   listHistoryPage keeps every messageAdded                    -> 1 check failed
//   gmailFetch stops retrying                                   -> 2 checks failed
//   gmailFetch retries dailyLimitExceeded                       -> 1 check failed
//   gmailFetch ignores Google's "Retry after <time>"            -> 1 check failed
//   the pacing map is keyed by the access token itself          -> 1 check failed
//   a day stopped part-way keeps nothing it fetched             -> 1 check failed

import { gmailRetry, pacingLanes } from "../../src/communications/gmail/api.js";
import { messageCachePath, MESSAGE_CACHE_VERSION } from "../../src/communications/gmail/messageCache.js";
import { getMessage, runIncrementalSync, syncDayFromGmail } from "../../src/communications/gmailSync.js";
import { createFixtureGmail, createMemoryStore, fixtureMessage, jsonResponse } from "./fixtures.mjs";

const SLUG = "p-at-example-invalid";
const DATE = "2026-10-17";
const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const NOTE = `inbox/email/${SLUG}/2026/10/${DATE}.md`;

function message(id, hour, extra = {}) {
  return fixtureMessage({
    id,
    threadId: `t-${id}`,
    date: `${DATE}T${String(hour).padStart(2, "0")}:00:00.000Z`,
    from: "a@example.invalid",
    to: "p@example.invalid",
    subject: `Subject ${id}`,
    text: `body of ${id}`,
    ...extra,
  });
}

function dayOptions(store, gmail, extra = {}) {
  return {
    store,
    fetchImpl: gmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: SLUG,
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    date: DATE,
    nonce: "n",
    remainingQuotaBytes: 1_000_000,
    wallClockMs: NOW,
    ...extra,
  };
}

const gets = (calls) => calls.filter((call) => /\/messages\/[^/?]+\?/.test(call));

export async function runGmailMessageCacheChecks(check) {
  // -- a second pass fetches only what is new -------------------------------
  const mailbox = [message("m1", 9), message("m2", 10)];
  const gmail = createFixtureGmail({ messages: mailbox });
  const store = createMemoryStore();
  await syncDayFromGmail(dayOptions(store, gmail));
  check("a day's first pass fetches every message on it", gets(gmail.calls).length === 2);

  mailbox.push(message("m3", 11));
  const later = createFixtureGmail({ messages: mailbox });
  await syncDayFromGmail(dayOptions(store, later));
  check("A DAY'S NEXT PASS FETCHES ONLY THE MESSAGE IT HAS NOT SEEN", gets(later.calls).length === 1 && gets(later.calls)[0].includes("/m3?"));

  const fresh = createMemoryStore();
  await syncDayFromGmail(dayOptions(fresh, createFixtureGmail({ messages: mailbox }), { messageCache: false }));
  const remembered = await (await store.get(NOTE)).text();
  check("a day rendered from remembered messages is byte-identical to one fetched whole", remembered === (await (await fresh.get(NOTE)).text()));

  const again = createFixtureGmail({ messages: mailbox });
  const unchanged = await syncDayFromGmail(dayOptions(store, again));
  check("an unchanged day fetches nothing and writes nothing", gets(again.calls).length === 0 && unchanged.bytesWritten === 0);

  // -- the list still decides what the day holds ----------------------------
  const archived = createFixtureGmail({ messages: mailbox.filter((entry) => entry.id !== "m2") });
  await syncDayFromGmail(dayOptions(store, archived));
  const text = await (await store.get(NOTE)).text();
  check("a message the day's list no longer names leaves the note, cache or not", !text.includes("Subject m2") && text.includes("Subject m3"));

  // -- a cache that cannot be trusted is not believed -----------------------
  const forged = createMemoryStore();
  await forged.put(
    messageCachePath(SLUG, DATE),
    JSON.stringify({ version: MESSAGE_CACHE_VERSION + 1, date: DATE, events: [{ messageId: "m1", subject: "forged", sentAt: `${DATE}T09:00:00.000Z` }] }),
  );
  const forgedGmail = createFixtureGmail({ messages: [message("m1", 9)] });
  await syncDayFromGmail(dayOptions(forged, forgedGmail));
  check("a cache from another version is ignored and the day is fetched", gets(forgedGmail.calls).length === 1 && !(await (await forged.get(NOTE)).text()).includes("forged"));

  // -- a new message is fetched once ----------------------------------------
  const incMailbox = [message("i1", 9), message("i2", 10)];
  const incGmail = createFixtureGmail({
    messages: incMailbox,
    history: { pages: [{ historyId: "20", history: [{ id: "19", messagesAdded: [{ message: { id: "i2", labelIds: ["INBOX", "UNREAD"] } }] }] }] },
  });
  await runIncrementalSync({
    store: createMemoryStore(),
    fetchImpl: incGmail.fetchImpl,
    accessToken: "tok",
    mailboxSlug: SLUG,
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    startHistoryId: "10",
    nonce: "n",
    quotaBytes: 1_000_000,
  });
  const i2Gets = gets(incGmail.calls).filter((call) => call.includes("/i2?")).length;
  check("AN INCREMENTAL PASS FETCHES A NEW MESSAGE ONCE, NOT ONCE TO DATE IT AND AGAIN TO RENDER IT", i2Gets === 1);

  // -- history that is not mail in the connection's folders costs nothing ----
  const noise = createFixtureGmail({
    messages: [message("draft", 9), message("spam", 10), message("archived", 11)],
    history: {
      pages: [{
        historyId: "30",
        history: [
          { id: "21", messagesAdded: [{ message: { id: "draft", labelIds: ["DRAFT"] } }] },
          { id: "22", messagesAdded: [{ message: { id: "spam", labelIds: ["SPAM", "INBOX"] } }] },
          { id: "23", messagesAdded: [{ message: { id: "archived", labelIds: ["Label_1"] } }] },
        ],
      }],
    },
  });
  const quiet = await runIncrementalSync({
    store: createMemoryStore(),
    fetchImpl: noise.fetchImpl,
    accessToken: "tok",
    mailboxSlug: SLUG,
    address: "p@example.invalid",
    folders: ["inbox", "sent"],
    startHistoryId: "20",
    nonce: "n",
    quotaBytes: 1_000_000,
  });
  check("a draft, spam and filtered-away mail in history fetch nothing and touch no day, and the cursor still moves",
    gets(noise.calls).length === 0 && quiet.daysTouched.length === 0 && quiet.historyId === "30");

  // -- Google's "slow down" is retried; "out for the day" is not -------------
  const sleeps = [];
  const realSleep = gmailRetry.sleep;
  gmailRetry.sleep = async (ms) => { sleeps.push(ms); };
  try {
    let answered = 0;
    const flaky = async (url) => {
      answered += 1;
      if (answered === 1) {
        return new Response(JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }], status: "RESOURCE_EXHAUSTED" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "3" },
        });
      }
      return createFixtureGmail({ messages: [message("r1", 9)] }).fetchImpl(url);
    };
    const got = await getMessage({ fetchImpl: flaky, accessToken: "retry-tok", id: "r1" });
    check("A 429 IS WAITED OUT AND RETRIED, FOR AS LONG AS RETRY-AFTER SAYS", got.id === "r1" && sleeps.length === 1 && sleeps[0] === 3000);

    let tries = 0;
    const always = async () => {
      tries += 1;
      return jsonResponse({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403);
    };
    const stubborn = await getMessage({ fetchImpl: always, accessToken: "tok", id: "x" }).catch((error) => error);
    check("a limit that does not lift fails the call after three retries", tries === 4 && stubborn?.status === 403 && stubborn?.reason === "userRateLimitExceeded");

    // -- calls on one token are spaced, so a backlog does not trip the per-user limit --
    sleeps.length = 0;
    const paced = createFixtureGmail({ messages: [message("p1", 9)] });
    await getMessage({ fetchImpl: paced.fetchImpl, accessToken: "pace-tok", id: "p1" });
    await getMessage({ fetchImpl: paced.fetchImpl, accessToken: "pace-tok", id: "p1" });
    await getMessage({ fetchImpl: paced.fetchImpl, accessToken: "other-tok", id: "p1" });
    check(
      "BACK-TO-BACK CALLS ON ONE TOKEN WAIT THEIR GAP; ANOTHER TOKEN DOES NOT WAIT FOR IT",
      sleeps.length === 1 && sleeps[0] > 0 && sleeps[0] <= gmailRetry.minGapMs,
    );

    // The map that spaces those calls is module scope, so it outlives the
    // request that minted the credential, in an isolate the runtime reuses
    // across tenants. `docs/decisions/storage-and-credentials.md`, "Never
    // cache a decrypted credential across requests": what it keeps per token
    // must therefore be a digest of the token and never the token.
    const minted = "ya29.a0-fixture-access-token-not-a-real-one-0123456789";
    await getMessage({ fetchImpl: paced.fetchImpl, accessToken: minted, id: "p1" });
    const lanes = pacingLanes();
    check(
      "NO ACCESS TOKEN IS LEFT BEHIND IN THE PACING MAP",
      lanes.length > 0 && lanes.every((lane) => /^[0-9a-f]{64}$/.test(lane)) && !lanes.includes(minted),
    );

    let daily = 0;
    const spent = async () => {
      daily += 1;
      return jsonResponse({ error: { errors: [{ reason: "dailyLimitExceeded" }] } }, 403);
    };
    await getMessage({ fetchImpl: spent, accessToken: "tok", id: "x" }).catch(() => undefined);
    check("a daily limit is not retried: seconds do not refill a day", daily === 1);

    // -- a lockout Google dates is not hammered, and says which call met it ----
    const until = new Date(Date.now() + 20 * 60_000).toISOString();
    let locked = 0;
    const lockedOut = async () => {
      locked += 1;
      return jsonResponse(
        { error: { message: `User-rate limit exceeded.  Retry after ${until}`, errors: [{ reason: "rateLimitExceeded" }] } },
        429,
      );
    };
    const lockout = await getMessage({ fetchImpl: lockedOut, accessToken: "lock-tok", id: "x" }).catch((error) => error);
    check(
      "A LIMIT GOOGLE SAYS LIFTS IN TWENTY MINUTES IS NOT RETRIED IN SECONDS, AND THE PASS LEARNS WHEN AND WHERE",
      locked === 1 && lockout?.retryAfterAt === Date.parse(until) && lockout?.call === "messagesGet",
    );

    // -- a day Google stops part-way resumes where it stopped ---------------
    const busy = [message("b1", 8), message("b2", 9), message("b3", 10), message("b4", 11)];
    const limited = createFixtureGmail({ messages: busy });
    const stopsAtB3 = async (url) =>
      String(url).includes("/messages/b3?")
        ? jsonResponse({ error: { errors: [{ reason: "dailyLimitExceeded" }] } }, 403)
        : limited.fetchImpl(url);
    const busyStore = createMemoryStore();
    const stopped = await syncDayFromGmail(dayOptions(busyStore, { fetchImpl: stopsAtB3 })).catch((error) => error);
    const resumed = createFixtureGmail({ messages: busy });
    await syncDayFromGmail(dayOptions(busyStore, resumed));
    check(
      "A DAY GOOGLE STOPS PART-WAY RESUMES WHERE IT STOPPED, NOT FROM ITS FIRST MESSAGE",
      stopped?.status === 403 &&
        gets(resumed.calls).length === 2 &&
        gets(resumed.calls).every((call) => call.includes("/b3?") || call.includes("/b4?")),
    );
  } finally {
    gmailRetry.sleep = realSleep;
  }
}
