/**
 * WHAT A GROUP CHAT'S ROUTINE AND CHECK-IN TURNS ARE ASKED (the owner, 2026-10-27;
 * `docs/decisions/texting-assistant/chat-routines.md`).
 *
 * The texting Worker queues a due chat routine or a chat's own check-in as a turn of the chat itself, its writer's tag
 * in these words (`apps/agent/src/groupRoutines.ts` `chatRoutineMessage`). They live here, plain JS, so the bench asks
 * a Dev test's group routine or check-in in exactly the words production does (`apps/mcp/bench/setsFd.mjs`).
 */
"use strict";

/** The path the control plane hands a chat's own check-in under (`textGroupLooks.ts`): no note. */
const CHAT_LOOK_PATH = "(check-in)";

/** When a run last went, in the routine's own time zone, or null when it never did or the zone is unknown. */
function lastRanWords(since, timeZone) {
  if (since === undefined) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone ?? "UTC",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(since));
  } catch {
    return null;
  }
}

/** Whether a routine is kept in its chat's home, `tex/groups/<words>/routines/` in `@context-lc` (the owner, 2026-11-02). */
const inChatHome = (path) => /^tex\/groups\/[a-z][a-z0-9-]*\/routines\//i.test(path);

/** What a chat routine's turn is asked: its writer's tag, in words only the Worker writes. */
function chatRoutineQuestion(path, lastRan = null) {
  return (
    `(It's time for this chat's routine, ${path}${inChatHome(path) ? ` (context: "@context-lc")` : ""}. Read that note and do what it says now, for everyone here, ` +
    "as if it had just been asked. " +
    (lastRan === null ? "" : `It last ran ${lastRan}: anything "new" means since then. `) +
    "If it only wants a word when there is something to say and there isn't, answer exactly SKIP.)"
  );
}

/**
 * What a chat's own check-in is asked (the owner, 2026-10-27: "heartbeats and
 * stuff just as dm Tex would do ... it should just work, and know when an
 * email needs to go to the group vs me personally"). Mail that needs only the
 * mailbox's own person is theirs: their own check-ins text them about it.
 */
function chatLookQuestion(since, lastRan) {
  const after = since === undefined ? "" : ` (search it with after:${Math.floor(since / 1000)})`;
  return (
    `(Time for this chat's check-in: look on your own at what is new${lastRan === null ? "" : ` since ${lastRan}`}, ` +
    `in three places only: mail shared with this chat${after}, mail sent to this chat's own address (the notes in its folder's email/ that arrived since), ` +
    "and what was asked of you in this chat that you said you would follow up on. " +
    "Never post about the workspace's other activity, notes or other agents' work: nobody here asked. " +
    "Post here only what someone in this chat needs to act on or know now, in one short line: " +
    "what happened and who should handle it. " +
    "Leave out mail that concerns only the mailbox's owner personally: their own check-ins text them about it. " +
    "Never post just to say hello or to summarize; newsletters, receipts and automated notices are not worth a message, " +
    "and neither is anything you already posted here. If nothing needs the chat, answer exactly SKIP.)"
  );
}

module.exports = { CHAT_LOOK_PATH, chatLookQuestion, chatRoutineQuestion, lastRanWords };
