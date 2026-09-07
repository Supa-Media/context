// Google Chat's extra grouping level: space (or DM), then thread, then
// message. Everything else about a channel-day note — the fixed frontmatter,
// the fence, the anchors, the split — is the shared machinery `note.test.mjs`
// already holds to the corpus; this file is only the part that is different
// about a Chat day, and the part that proves an email or iMessage day is
// completely unaffected by it existing.
//
// SABOTAGE RECORD
//   branch on `events.some(e => e.space)` instead of `day.channel`  -> 1 check failed
//   drop defangOutsideFence from the space heading                  -> 1 check failed
//   render a space's raw resource name instead of its displayName   -> 7 checks failed
//   render unavailableSpaces on every part instead of just part 1   -> 1 check failed
//   bail out to "(no messages)" even when unavailableSpaces exist   -> 1 check failed
//
// The first run of the first and last of these passed a version of this file
// that let an uncaught exception abort the whole suite silently reporting "0
// failures" instead of a real one — `groupIntoSpaces(...).find(...)` chained
// straight into `.threads` with nothing to catch a `find` that came back
// `undefined` once the sabotage changed what a label contains. Every check
// here that chains off a lookup is now `try/catch`-guarded for exactly that
// reason: a check that can crash the process is a check nobody sees fail.

import { PART_HEADER_RESERVE } from "../src/protocol.js";
import { groupIntoSpaces, parseChannelDayNote, planChannelDay, renderChannelDayNote, utf8Length } from "../src/note.js";
import { messageAnchor, spaceKey } from "../src/anchors.js";
import { chatDay, chatMessage, day } from "./fixtures.mjs";

/** A Chat day heavy enough to force a split, mirroring `bulkyDay`. */
function bulkyChatDay(count, bytesEach = 4_000) {
  const events = [];
  for (let i = 0; i < count; i += 1) {
    events.push(
      chatMessage({
        messageId: `spaces/AAAA1111/messages/bulk-${i}`,
        threadId: `spaces/AAAA1111/threads/thread-${i % 3}`,
        sentAt: new Date(Date.UTC(2026, 8, 7, 8, i)).toISOString(),
        subject: i % 10 === 0 ? `Update ${i}` : "",
        body: "x".repeat(bytesEach),
      })
    );
  }
  return chatDay({ events });
}

export function runChatChecks(check) {
  const rendered = renderChannelDayNote(chatDay());
  const parsed = parseChannelDayNote(rendered);

  // -- grouping ---------------------------------------------------------
  check("a Chat day groups into its two spaces", groupIntoSpaces(chatDay().events).length === 2);
  check(
    "...each holding its own threads, in first-message order",
    (() => {
      try {
        // Found by key rather than by label text, so this check is
        // independent of whatever `spaceLabel` does — a mislabelled space is
        // a different check's job to catch.
        const spaces = groupIntoSpaces(chatDay().events);
        const engineering = spaces.find((s) => s.key === spaceKey(chatMessage()));
        return engineering.threads.length === 2 && engineering.threads[0].events[0].sentAt === "2026-09-07T09:00:00.000Z";
      } catch {
        return false;
      }
    })()
  );
  check("a named space is labelled by its display name", rendered.includes("## Space — Engineering Team"));
  check(
    "a direct message with no display name still gets a heading",
    rendered.includes("## Direct message") && !rendered.includes("## Direct message — ")
  );
  check(
    "a direct message with a display name is labelled by it",
    renderChannelDayNote(
      chatDay({ events: [chatMessage({ space: { key: "spaces/CCCC", displayName: "Bea Lindqvist", type: "direct_message" } })] })
    ).includes("## Direct message — Bea Lindqvist")
  );

  // -- heading depth: one level deeper than every other channel ----------
  check("a Chat thread heading is one level deeper than email's", rendered.includes("### Thread — "));
  check("a Chat message heading is one level deeper than email's", /^#### \d\d:\d\d/m.test(rendered));
  check("the frontmatter counts every message and thread, whatever space it is in", parsed.frontmatter.messages === "5" && parsed.frontmatter.threads === "3");

  // -- round-trip through the parser --------------------------------------
  check("every message anchor round-trips", parsed.anchors.length === 5);
  check(
    "...tagged with the space it was written under",
    parsed.messages.filter((m) => m.space.includes("Engineering")).length === 3 &&
      parsed.messages.filter((m) => m.space.includes("Direct message")).length === 2
  );
  check(
    "...and the thread it was written under",
    (() => {
      const found = parsed.messages.find(
        (m) => m.anchor === messageAnchor({ channel: "google-chat", account: "chat-connection-1", messageId: "spaces/AAAA1111/messages/msg-a3" })
      );
      return found?.thread === "Standup notes";
    })()
  );
  check(
    "a thread with no subject still gets a thread heading, not a bare message",
    parsed.messages.some((m) => m.thread === "(no subject)")
  );

  // -- email and iMessage are completely unaffected ------------------------
  const emailRendered = renderChannelDayNote(day());
  check("an email day never gains a space heading", !emailRendered.includes("## Space") && !emailRendered.includes("## Direct message"));
  check("...nor a fourth-level message heading", !/^#### /m.test(emailRendered));
  check("...and its Thread heading stays at the level it always was", emailRendered.includes("## Thread — "));
  check(
    "planChannelDay for a non-Chat day is unaffected by grouping into spaces",
    planChannelDay(day())[0].text === renderChannelDayNote({ ...day(), part: 1, parts: 1 })
  );

  // -- determinism: arrival order never changes the bytes ------------------
  check(
    "a Chat day rendered from a shuffled array is byte-identical",
    renderChannelDayNote(chatDay({ events: [...chatDay().events].reverse() })) === rendered
  );

  // -- no raw provider id, including a space's resource name, reaches the file
  check(
    "no raw space, thread or message id reaches the bucket",
    (() => {
      const ids = chatDay().events.flatMap((e) => [e.messageId, e.threadId, e.space.key]);
      return ids.length === 15 && ids.every((id) => !rendered.includes(id));
    })()
  );

  // -- a sender-influenced space name cannot open a link or a heading ------
  check(
    "a hostile space display name cannot open a wikilink in its own heading",
    (() => {
      const attack = "Legal]] and [[.audit/anything|click";
      const text = renderChannelDayNote(
        chatDay({ events: [chatMessage({ space: { key: "spaces/DDDD", displayName: attack, type: "group_chat" } })] })
      );
      const heading = text.split("\n").find((row) => row.startsWith("## "));
      return !heading.includes("]]") && !heading.includes("[[") && heading.includes("Legal");
    })()
  );

  // -- history unavailable: an honest gap, not a silent one -----------------
  const withGap = renderChannelDayNote({ ...chatDay(), unavailableSpaces: [{ label: "Legal Team", reason: "history-off" }] });
  check("a space whose history is off gets an honest marker", withGap.includes("## Legal Team (history unavailable)"));
  check("...naming which policy caused it", withGap.includes("History unavailable") && withGap.includes("history is off"));
  const withNoAccess = renderChannelDayNote({ ...chatDay(), unavailableSpaces: [{ label: "Ops", reason: "no-access" }] });
  check(
    "...and a distinct reason when membership prevents it, not the same prose reused",
    withNoAccess.includes("can no longer read this space's") && !withNoAccess.includes("history is off")
  );
  check(
    "a day with zero messages but an unavailable space is still a well-formed note, not '(no messages)'",
    (() => {
      const text = renderChannelDayNote({ ...chatDay(), events: [], unavailableSpaces: [{ label: "Legal", reason: "history-off" }] });
      return text.includes("(history unavailable)") && !text.includes("_(no messages)_");
    })()
  );
  check(
    "a day with truly nothing — no messages, nothing unavailable — is still '(no messages)'",
    renderChannelDayNote({ ...chatDay(), events: [] }).includes("_(no messages)_")
  );
  check(
    "the unavailable-space notice is written once, on part one, never repeated on every part",
    !renderChannelDayNote({ ...chatDay(), part: 2, parts: 2, unavailableSpaces: [{ label: "Legal", reason: "history-off" }] }).includes(
      "history unavailable"
    )
  );

  // -- splitting: the space heading survives a split like the thread heading does
  const parts = planChannelDay(bulkyChatDay(20, 4_000), { threshold: PART_HEADER_RESERVE + 20_000 });
  check("an oversized Chat day splits", parts.length > 1);
  check("every message lands in exactly one part", parts.reduce((total, part) => total + part.events.length, 0) === 20);
  check(
    "...and no anchor appears twice across the day",
    (() => {
      const anchors = parts.flatMap((part) => parseChannelDayNote(part.text).anchors);
      return new Set(anchors).size === anchors.length;
    })()
  );
  check("every part carries a space heading, not just the first", parts.every((part) => part.text.includes("## Space — Engineering Team")));
  check(
    "every part is inside the threshold",
    parts.every((part) => utf8Length(part.text) <= PART_HEADER_RESERVE + 20_000)
  );
  check(
    "the split is a pure function of the day, not of arrival order",
    (() => {
      const source = bulkyChatDay(20, 4_000);
      const shuffled = { ...source, events: [...source.events].reverse() };
      const first = planChannelDay(source, { threshold: PART_HEADER_RESERVE + 20_000 });
      const second = planChannelDay(shuffled, { threshold: PART_HEADER_RESERVE + 20_000 });
      return first.map((p) => p.text).join("") === second.map((p) => p.text).join("");
    })()
  );
}
