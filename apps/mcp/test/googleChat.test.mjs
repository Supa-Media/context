// Google Chat sync: spaces -> messages -> channel-day notes, against a
// fixture Chat API replaying Google's documented response shapes
// (`googleChatFixture.mjs`). Nothing here touches the network, Convex, or a
// real credential — every dependency `syncGoogleChat` needs is injected, the
// same shape `docs/decisions/communications.md`, "Chat sync is built against
// an injected client" argues for.
//
// SABOTAGE RECORD
//   make first sync read history instead of baselining at now          -> 3 checks failed
//   read messages with `create_time >= cursor` instead of `>`          -> 2 checks failed
//   REGEN_LOOKBACK_DAYS = 0, so an edit soon after sync misses          -> 2 checks failed
//   advance a denied space's cursor anyway                             -> 1 check failed
//   let one space's unexpected error abort the whole sync              -> 1 check failed
//   derive the day nonce from account+date alone, dropping nonceSeed   -> 1 check failed
//   isHistoryOn always returns true, ignoring HISTORY_OFF entirely     -> 3 checks failed
//
// The first run of the first sabotage crashed the whole process instead of
// failing 11 checks: `section()` did not exist yet, `syncGoogleChat` threw
// (`new Date(-Infinity).toISOString()`) straight out of an `await` this file
// had not wrapped, and the crash would have taken every test file after this
// one in `test.mjs`'s single process down with it. Every block below now
// runs inside `section()`, which turns a thrown error into an ordinary
// failed check — the same "a check that can crash the process is a check
// nobody sees fail" lesson `packages/communications/test/chat.test.mjs`
// already recorded, learned again one layer up.

import { listMessagesPage, listSpacesPage } from "../src/communications/googleChat/client.js";
import { estimateChatBackfill, estimateChatBackfillWindows, BACKFILL_WINDOW_DAYS } from "../src/communications/googleChat/backfill.js";
import { chatMessageToEvent, chatSpaceType, isHistoryOn } from "../src/communications/googleChat/transform.js";
import { CHAT_SCOPES, DEFAULT_BACKFILL_DAYS } from "../src/communications/googleChat/protocol.js";
import { dayNonce, syncGoogleChat } from "../src/communications/googleChat/sync.js";
import { parseChannelDayNote } from "../../../packages/communications/src/note.js";
import { createChatFixture, fixtureMessage, fixtureSpace } from "./googleChatFixture.mjs";

const ACCESS_TOKEN = "test-access-token";

/** Adapters matching what `syncGoogleChat` expects, built over one fixture. */
function clientFor(fetchImpl) {
  return {
    listSpaces: ({ pageToken }) => listSpacesPage({ fetchImpl, accessToken: ACCESS_TOKEN, pageToken }),
    listMessages: ({ spaceName, sinceCreateTime, pageToken }) =>
      listMessagesPage({ fetchImpl, accessToken: ACCESS_TOKEN, spaceName, sinceCreateTime, pageToken }),
  };
}

function noteFor(result, date) {
  return result.notes.find((part) => part.path.endsWith(`${date}.md`));
}

export async function runGoogleChatChecks(check) {
  const NOW = "2026-09-07T18:00:00.000Z";
  const ENGINEERING = "spaces/AAAAAAAAAAA";
  const DM = "spaces/BBBBBBBBBBB";

  /**
   * Run one block of checks, catching whatever it throws rather than letting
   * it crash the whole process. `note.test.mjs`'s sabotage record already
   * found this the hard way once: an uncaught exception here would not just
   * hide the rest of this file's checks, it would abort every other test
   * file `test.mjs` still had left to run after it, and a process that dies
   * mid-run prints nothing distinguishing that from a clean pass at a glance.
   * A closure over this call's own `check`, not a module-level function, so
   * it never silently reaches for the wrong one if this file ever runs two
   * suites in one process.
   */
  async function section(name, fn) {
    try {
      await fn();
    } catch (err) {
      check(`${name} did not throw: ${err?.stack ?? err}`, false);
    }
  }

  // -- the client, over the fixture's own HTTP shape -----------------------
  await section("client: listSpacesPage pagination", async () => {
    const spaces = [fixtureSpace({ name: ENGINEERING }), fixtureSpace({ name: DM, spaceType: "DIRECT_MESSAGE", displayName: "" })];
    const fetchImpl = createChatFixture({ spaces, pageSize: 1 });
    const page1 = await listSpacesPage({ fetchImpl, accessToken: ACCESS_TOKEN });
    check("a page of spaces carries a nextPageToken when more remain", page1.items.length === 1 && Boolean(page1.nextPageToken));
    const page2 = await listSpacesPage({ fetchImpl, accessToken: ACCESS_TOKEN, pageToken: page1.nextPageToken });
    check("...and the last page carries none", page2.items.length === 1 && page2.nextPageToken === undefined);
    check("the bearer token reaches every request", fetchImpl.calls.every((c) => c.auth === `Bearer ${ACCESS_TOKEN}`));
  });
  await section("client: listMessagesPage filter is exclusive of the cursor", async () => {
    const messages = [
      fixtureMessage({ name: `${ENGINEERING}/messages/m1`, createTime: "2026-09-01T00:00:00Z" }),
      fixtureMessage({ name: `${ENGINEERING}/messages/m2`, createTime: "2026-09-02T00:00:00Z" }),
    ];
    const fetchImpl = createChatFixture({ spaces: [], messagesBySpace: { [ENGINEERING]: messages }, pageSize: 100 });
    const page = await listMessagesPage({ fetchImpl, accessToken: ACCESS_TOKEN, spaceName: ENGINEERING, sinceCreateTime: "2026-09-01T00:00:00.000Z" });
    check(
      "the filter is exclusive of the cursor timestamp itself",
      page.items.length === 1 && page.items[0].name.endsWith("/m2")
    );
  });
  await section("client: a denied space throws a structured error", async () => {
    const fetchImpl = createChatFixture({ deniedSpaces: new Set([ENGINEERING]) });
    const error = await listMessagesPage({ fetchImpl, accessToken: ACCESS_TOKEN, spaceName: ENGINEERING, sinceCreateTime: "2026-01-01T00:00:00.000Z" }).catch((e) => e);
    check("a denied space throws a structured, catchable error", error?.code === "PERMISSION_DENIED");
    check("...never a raw HTTP status a caller has to remember", typeof error.code === "string");
  });

  // -- transform: Chat's shapes -> CommunicationEvent -----------------------
  check("a GROUP_CHAT space normalizes to group_chat", chatSpaceType(fixtureSpace({ spaceType: "GROUP_CHAT" })) === "group_chat");
  check("a DIRECT_MESSAGE space normalizes to direct_message", chatSpaceType(fixtureSpace({ spaceType: "DIRECT_MESSAGE" })) === "direct_message");
  check("an unrecognized spaceType is treated as a named space, not a DM", chatSpaceType(fixtureSpace({ spaceType: "" })) === "space");
  check("HISTORY_ON is on", isHistoryOn(fixtureSpace({ spaceHistoryState: "HISTORY_ON" })));
  check("HISTORY_OFF is off", !isHistoryOn(fixtureSpace({ spaceHistoryState: "HISTORY_OFF" })));
  check("a space with no history field at all defaults on", isHistoryOn(fixtureSpace({ spaceHistoryState: undefined })));
  await section("transform: chatMessageToEvent field mapping", async () => {
    const event = chatMessageToEvent({ space: fixtureSpace(), message: fixtureMessage(), account: "chat-conn-1" });
    check("channel is always google-chat", event.channel === "google-chat");
    check("the message id is the provider's resource name, unhashed at this layer", event.messageId === "spaces/AAAAAAAAAAA/messages/msg-1");
    check("the thread id comes from message.thread.name", event.threadId === "spaces/AAAAAAAAAAA/threads/thr-1");
    check("a message with no thread falls back to its own name", chatMessageToEvent({ space: fixtureSpace(), message: fixtureMessage({ thread: undefined }), account: "a" }).threadId === "spaces/AAAAAAAAAAA/messages/msg-1");
    check("the sender's display name is used, never their resource name", event.from.name === "Adam Okonkwo" && !event.from.name.includes("users/"));
    check("subject is a preview of the message's own text", event.subject.startsWith("Morning!"));
    check("space.key carries the provider's raw name for identity hashing, not display", event.space.key === "spaces/AAAAAAAAAAA");
  });
  await section("transform: a deleted message becomes a tombstone", async () => {
    const deleted = chatMessageToEvent({ space: fixtureSpace(), message: fixtureMessage({ deletionMetadata: { deletionType: "CREATOR" } }), account: "a" });
    check("a deleted message becomes a fixed, non-empty tombstone body", deleted.body.length > 0 && !deleted.body.includes("Morning"));
    check("...never the sender's own text, whatever it said", !deleted.body.includes("Thursday"));
  });

  // -- the day nonce: deterministic, but not guessable from public fields --
  check("the same seed, account and date always give the same nonce", dayNonce("seed-1", "acct", "2026-09-07") === dayNonce("seed-1", "acct", "2026-09-07"));
  check("a different seed gives a different nonce for the same account and date", dayNonce("seed-1", "acct", "2026-09-07") !== dayNonce("seed-2", "acct", "2026-09-07"));
  check("a different date gives a different nonce", dayNonce("seed-1", "acct", "2026-09-07") !== dayNonce("seed-1", "acct", "2026-09-08"));

  // -- the sync: forward-only baseline --------------------------------------
  await section("sync: first pass baselines without backfill", async () => {
    const space = fixtureSpace({ name: ENGINEERING });
    const old = fixtureMessage({ name: `${ENGINEERING}/messages/old`, createTime: "2026-01-01T00:00:00Z" });
    const recent = fixtureMessage({ name: `${ENGINEERING}/messages/recent`, createTime: "2026-09-06T12:00:00Z" });
    const fetchImpl = createChatFixture({ spaces: [space], messagesBySpace: { [ENGINEERING]: [old, recent] } });
    const result = await syncGoogleChat({
      ...clientFor(fetchImpl),
      connection: { account: "acct", nonceSeed: "seed" },
      now: NOW,
    });
    const allEvents = result.notes.flatMap((part) => part.events);
    check("a first sync writes no old messages", allEvents.length === 0);
    check("the cursor starts at the sync time", result.cursors[ENGINEERING] === NOW);
    check("the default backfill window is zero days", DEFAULT_BACKFILL_DAYS === 0);
  });
  await section("sync: configured destination folder", async () => {
    const space = fixtureSpace({ name: ENGINEERING });
    const message = fixtureMessage({ name: `${ENGINEERING}/messages/dest`, createTime: "2026-09-06T12:00:00Z" });
    const fetchImpl = createChatFixture({ spaces: [space], messagesBySpace: { [ENGINEERING]: [message] } });
    const result = await syncGoogleChat({
      ...clientFor(fetchImpl),
      connection: {
        account: "acct",
        nonceSeed: "seed",
        cursors: { [ENGINEERING]: "2026-09-06T00:00:00.000Z" },
        destinationFolder: "2-areas/communications/daily",
      },
      now: NOW,
    });
    check(
      "a configured Chat destination folder controls where daily notes are written",
      result.notes.some((part) => part.path === "2-areas/communications/daily/2026-09-06.md"),
    );
  });

  // -- per-space settings: excluded and paused sync nothing -----------------
  await section("sync: per-space include/exclude settings", async () => {
    const included = fixtureSpace({ name: ENGINEERING });
    const excluded = fixtureSpace({ name: DM, spaceType: "DIRECT_MESSAGE" });
    const messages = { [ENGINEERING]: [fixtureMessage({ name: `${ENGINEERING}/messages/a`, createTime: "2026-09-06T00:00:00Z" })], [DM]: [fixtureMessage({ name: `${DM}/messages/b`, createTime: "2026-09-06T00:00:00Z" })] };
    const fetchImpl = createChatFixture({ spaces: [included, excluded], messagesBySpace: messages });
    const result = await syncGoogleChat({
      ...clientFor(fetchImpl),
      connection: {
        account: "acct",
        nonceSeed: "seed",
        cursors: { [ENGINEERING]: "2026-09-06T00:00:00.000Z" },
        spaceSettings: { [DM]: "excluded" },
      },
      now: NOW,
    });
    check("an excluded space contributes no events", !result.notes.some((part) => part.events.some((e) => e.space.key === DM)));
    check("...and an included one still does", result.notes.some((part) => part.events.some((e) => e.space.key === ENGINEERING)));
    check("an excluded space's cursor is never written", result.cursors[DM] === undefined);
    check("spaces are reported with their resolved state, for a settings UI to render", result.spaces.find((s) => s.key === DM)?.state === "excluded");
  });

  // -- history unavailable: honest, once, on today's note -------------------
  await section("sync: HISTORY_OFF marker on today's note", async () => {
    const off = fixtureSpace({ name: ENGINEERING, spaceHistoryState: "HISTORY_OFF" });
    const fetchImpl = createChatFixture({ spaces: [off], messagesBySpace: { [ENGINEERING]: [] } });
    const result = await syncGoogleChat({
      ...clientFor(fetchImpl),
      connection: { account: "acct", nonceSeed: "seed", cursors: { [ENGINEERING]: "2026-09-06T00:00:00.000Z" } },
      now: NOW,
    });
    const today = noteFor(result, "2026-09-07");
    check("a HISTORY_OFF space with zero messages still produces today's note", Boolean(today));
    check("...carrying the honest marker", today?.text.includes("history unavailable") && today?.text.includes("history is off"));
  });
  await section("sync: no-access marker on today's note", async () => {
    const denied = fixtureSpace({ name: ENGINEERING });
    const fetchImpl = createChatFixture({ spaces: [denied], deniedSpaces: new Set([ENGINEERING]) });
    const result = await syncGoogleChat({
      ...clientFor(fetchImpl),
      connection: { account: "acct", nonceSeed: "seed", cursors: { [ENGINEERING]: "2026-09-06T00:00:00.000Z" } },
      now: NOW,
    });
    const today = noteFor(result, "2026-09-07");
    check("a denied space also produces today's note, with the other reason", today?.text.includes("can no longer read this space's"));
    check(
      "...and its cursor is left untouched so the next sync retries from where it left off",
      result.cursors[ENGINEERING] === "2026-09-06T00:00:00.000Z",
    );
  });

  // -- resilience: one space's unexpected failure does not abort the sync ---
  await section("sync: one space's failure does not abort the sync", async () => {
    const good = fixtureSpace({ name: ENGINEERING });
    const bad = fixtureSpace({ name: DM, spaceType: "DIRECT_MESSAGE" });
    const messages = { [ENGINEERING]: [fixtureMessage({ name: `${ENGINEERING}/messages/a`, createTime: "2026-09-06T00:00:00Z" })] };
    // DM answers with a transient 500 -- the generic, retry-worthy error
    // path, distinct from the two provider-classified reasons above.
    const fetchImpl = createChatFixture({ spaces: [good, bad], messagesBySpace: messages, failingSpaces: new Set([DM]) });
    const result = await syncGoogleChat({
      ...clientFor(fetchImpl),
      connection: { account: "acct", nonceSeed: "seed", cursors: { [ENGINEERING]: "2026-09-06T00:00:00.000Z" } },
      now: NOW,
    });
    check("the failing space is recorded in errors", result.errors.some((e) => e.space === DM));
    check("...and the healthy space still synced", result.notes.some((part) => part.events.some((e) => e.space.key === ENGINEERING)));
  });

  // -- idempotency, edits and deletions --------------------------------------
  await section("sync: idempotency, edits and deletions", async () => {
    const space = fixtureSpace({ name: ENGINEERING });
    const msg = fixtureMessage({ name: `${ENGINEERING}/messages/edit-me`, createTime: "2026-09-06T09:00:00Z", text: "original text" });
    const world = { spaces: [space], messagesBySpace: { [ENGINEERING]: [msg] } };
    const connection = {
      account: "acct",
      nonceSeed: "seed",
      cursors: { [ENGINEERING]: "2026-09-06T00:00:00.000Z" },
    };

    const first = await syncGoogleChat({ ...clientFor(createChatFixture(world)), connection, now: NOW });
    const firstDay = noteFor(first, "2026-09-06");
    check("a message renders with its original text", firstDay?.text.includes("original text"));

    const again = await syncGoogleChat({ ...clientFor(createChatFixture(world)), connection, now: NOW });
    check(
      "re-running the same sync from the same (unpersisted) cursor is byte-identical",
      noteFor(again, "2026-09-06")?.text === firstDay?.text
    );

    // The caller persists `first.cursors` between runs; a resync starting
    // from that cursor still has to see an edit made after it, which is
    // exactly what REGEN_LOOKBACK_DAYS is for.
    const editedWorld = {
      spaces: [space],
      messagesBySpace: {
        [ENGINEERING]: [{ ...msg, text: "edited: pushed to Friday instead", lastUpdateTime: "2026-09-06T10:00:00Z" }],
      },
    };
    const resynced = await syncGoogleChat({
      ...clientFor(createChatFixture(editedWorld)),
      connection: { ...connection, cursors: first.cursors },
      now: "2026-09-07T09:00:00.000Z",
    });
    const editedDay = noteFor(resynced, "2026-09-06");
    check("an edit made after the cursor is picked up by the lookback window", editedDay?.text.includes("edited: pushed to Friday"));
    check("...and the original text is gone, not merely appended", !editedDay?.text.includes("original text"));
    check(
      "the anchor is unchanged across the edit, so a link into it still resolves",
      parseChannelDayNote(firstDay.text).anchors[0] === parseChannelDayNote(editedDay.text).anchors[0]
    );

    const deletedWorld = {
      spaces: [space],
      messagesBySpace: { [ENGINEERING]: [{ ...msg, deletionMetadata: { deletionType: "CREATOR" } }] },
    };
    const afterDelete = await syncGoogleChat({
      ...clientFor(createChatFixture(deletedWorld)),
      connection: { ...connection, cursors: first.cursors },
      now: "2026-09-07T09:00:00.000Z",
    });
    const deletedDay = noteFor(afterDelete, "2026-09-06");
    check("a deletion applied on regeneration replaces the body with a tombstone", deletedDay?.text.includes("was deleted") && !deletedDay?.text.includes("original text"));
    check(
      "...keeping the same anchor, so old links still land on the right heading",
      parseChannelDayNote(firstDay.text).anchors[0] === parseChannelDayNote(deletedDay.text).anchors[0]
    );
  });

  // -- no raw provider id anywhere in what gets written ----------------------
  await section("sync: no raw provider id reaches the file", async () => {
    const space = fixtureSpace({ name: ENGINEERING, displayName: "Legal & Ops" });
    const msg = fixtureMessage({ name: `${ENGINEERING}/messages/xyz`, createTime: "2026-09-06T09:00:00Z" });
    const fetchImpl = createChatFixture({ spaces: [space], messagesBySpace: { [ENGINEERING]: [msg] } });
    const result = await syncGoogleChat({
      ...clientFor(fetchImpl),
      connection: {
        account: "acct-secret-handle",
        nonceSeed: "seed",
        cursors: { [ENGINEERING]: "2026-09-06T00:00:00.000Z" },
      },
      now: NOW,
    });
    const text = result.notes.map((p) => p.text).join("\n");
    check("no raw space resource name reaches the file", !text.includes(ENGINEERING));
    check("no raw message id reaches the file", !text.includes("messages/xyz"));
    // The account *handle* is written into frontmatter deliberately, the same
    // way email's is (`account: "name@example.com"`) — it identifies which
    // connection a day came from and is not a credential. What must never
    // appear is the provider's own ids, checked above.
    check("the connection's account is recorded, the same way email's is", text.includes("acct-secret-handle"));
  });

  // -- legacy backfill estimates: bounded windows, never all-time ------------
  check("only 90 and 365 day windows are offered, never an unbounded one", BACKFILL_WINDOW_DAYS.length === 2 && BACKFILL_WINDOW_DAYS.includes(90) && BACKFILL_WINDOW_DAYS.includes(365));
  check("zero spaces estimates zero of everything", estimateChatBackfill({ spaceCount: 0, days: 90 }).estimatedMessages === 0);
  check("more spaces means a larger estimate for the same window", estimateChatBackfill({ spaceCount: 5, days: 90 }).estimatedMessages > estimateChatBackfill({ spaceCount: 1, days: 90 }).estimatedMessages);
  check("a longer window means a larger estimate for the same spaces", estimateChatBackfill({ spaceCount: 3, days: 365 }).estimatedMessages > estimateChatBackfill({ spaceCount: 3, days: 90 }).estimatedMessages);
  check("the byte range is low <= high", (() => { const e = estimateChatBackfill({ spaceCount: 3, days: 90 }); return e.estimatedBytesLow <= e.estimatedBytesHigh; })());
  check("the windows helper answers exactly the offered windows", Object.keys(estimateChatBackfillWindows({ spaceCount: 2 })).sort().join(",") === "365,90");

  // -- scopes recorded verbatim -----------------------------------------------
  check(
    "the Chat scopes are recorded verbatim, restricted and sensitive alike",
    CHAT_SCOPES.includes("https://www.googleapis.com/auth/chat.messages.readonly") &&
      CHAT_SCOPES.includes("https://www.googleapis.com/auth/chat.spaces.readonly")
  );
  check("...and nothing broader than read-only", CHAT_SCOPES.every((scope) => scope.endsWith(".readonly")));
}
