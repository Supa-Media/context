/**
 * A thumbs up on an ask is the yes, once it has stayed ten seconds (Dev2,
 * 2026-10-21). `thumbs.ts`; the gateway's half is `thumbsUpIsYes`.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `dueThumb` releasing at once (hold 0). → `waits ten seconds …` fails.
 *  2. `dropThumb` never deleting. → `taking it back inside ten seconds …` fails.
 *  3. Group `acceptThumb` not checking the asker. → `only the asker's like …` fails.
 *  4. `onTheAsk` returning the reaction unchanged. → `a 👍 on the line above
 *     the ask is a 👍 on the ask …` fails.
 */

import { describe, expect, it } from "vitest";
import { drain, react, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { readRemovedTapback } from "./reactions";
import { parseSendblueInbound } from "./sendblue";
import { parseSendblueGroup, type GroupMessage } from "./sendblueGroups";
import { acceptGroup, drainGroup, type GroupDeps } from "./groupInbox";
import { holdsAsYes, rememberAskReply, THUMB_HOLD_MS } from "./thumbs";
import type { Fetch } from "./clients";

const NOW = 1_800_000_000_000;
const ASK = "Here's the email I'd send:\n\nTo: jo@example.com\nSubject: Thursday\n\nThursday works.\n\nGive it a 👍 and I'll send it.";

const tapback = (eventId: string, how: "Liked" | "Loved", words: string, removed = false) => ({
  kind: "reaction" as const,
  eventId,
  chatId: "chat_1",
  from: "+15555550100",
  messageId: `m_${eventId}`,
  reaction: { how, words, ...(removed ? { removed: true as const } : {}) },
});

function deps(asks: Record<string, unknown>[], clock: { now: number }): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (path === "/agent") {
      asks.push(body);
      return Response.json({ answer: "Sent." });
    }
    return Response.json({ id: "x" });
  }) as unknown as InboxDeps["fetch"];
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://control.example",
    workerSecret: "secret",
    gatewayOrigin: "https://gateway.example",
    linqApiKey: "key",
    now: () => clock.now,
  } as InboxDeps;
}

describe("a thumbs up on an ask, one to one", () => {
  it("holds a like or a heart on an ask, and nothing else", () => {
    expect(holdsAsYes({ how: "Liked", words: ASK })).toBe(true);
    expect(holdsAsYes({ how: "Loved", words: "Here's the bug report I'd send to the Context team: …" })).toBe(true);
    expect(holdsAsYes({ how: "Liked", words: "Dinner is booked for 7." })).toBe(false);
    expect(holdsAsYes({ how: "Liked", words: ASK, removed: true })).toBe(false);
  });

  it("waits ten seconds, then goes as the tapback it is, with the ask's words", async () => {
    const storage = new MemoryStorage();
    const asks: Record<string, unknown>[] = [];
    const clock = { now: NOW };
    expect(await react(storage, tapback("t1", "Liked", ASK), NOW)).toBe("held");
    clock.now = NOW + THUMB_HOLD_MS - 1;
    await drain(storage, deps(asks, clock));
    expect(asks).toHaveLength(0);
    clock.now = NOW + THUMB_HOLD_MS;
    await drain(storage, deps(asks, clock));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ question: "👍", quoted: ASK, tapback: "Liked" });
  });

  it("taking it back inside ten seconds sends nothing", async () => {
    const storage = new MemoryStorage();
    const asks: Record<string, unknown>[] = [];
    await react(storage, tapback("t1", "Liked", ASK), NOW);
    expect(await react(storage, tapback("t2", "Liked", ASK, true), NOW + 4_000)).toBe("dropped");
    await drain(storage, deps(asks, { now: NOW + THUMB_HOLD_MS + 1 }));
    expect(asks).toHaveLength(0);
  });

  it("reads a like taken back off an ask from Sendblue, and ignores one taken back off anything else", () => {
    expect(readRemovedTapback(`Removed a like from “${ASK}”`)).toEqual({ how: "Liked", words: ASK, removed: true });
    const webhook = (content: string) => ({
      message_handle: "h1",
      is_outbound: false,
      from_number: "+15555550100",
      sendblue_number: "+15555550199",
      service: "iMessage",
      content,
    });
    expect(parseSendblueInbound(webhook(`Removed a like from “${ASK}”`))).toMatchObject({ kind: "reaction", reaction: { removed: true } });
    // Any taken-back like reaches the inbox, which drops it only if it is the one being held.
    expect(parseSendblueInbound(webhook("Removed a like from “see you then”"))).toMatchObject({ kind: "reaction", reaction: { removed: true } });
  });

  it("still holds a like on an ask in the earlier words, sent before the change", () => {
    expect(holdsAsYes({ how: "Liked", words: "Here's the email I'd send: … Look good? Give this a 👍 or say yes and I'll send it." })).toBe(true);
  });

  // Dev2, 2026-10-21: "a thumbs up should always be seen as an approval".
  it("a 👍 on the line above the ask is a 👍 on the ask, and only for the reply that carried it", async () => {
    const LINE_ABOVE = "I'll forward the receipt with its PDFs to Relay.";
    const storage = new MemoryStorage();
    const asks: Record<string, unknown>[] = [];
    await rememberAskReply(storage, [LINE_ABOVE, ASK], NOW);
    expect(await react(storage, tapback("t1", "Liked", LINE_ABOVE), NOW)).toBe("held");
    await drain(storage, deps(asks, { now: NOW + THUMB_HOLD_MS }));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ question: "👍", quoted: ASK, tapback: "Liked" });

    // Taken back inside ten seconds, it is dropped by the words it was on. ("Sent." above was a reply with no ask.)
    await rememberAskReply(storage, [LINE_ABOVE, ASK], NOW + 15_000);
    await react(storage, tapback("t2", "Liked", LINE_ABOVE), NOW + 20_000);
    expect(await react(storage, tapback("t3", "Liked", LINE_ABOVE, true), NOW + 22_000)).toBe("dropped");

    // A later reply with no ask forgets it: a 👍 on that line is a tapback on that line.
    await rememberAskReply(storage, ["Done, I sent an email to jo@example.com."], NOW + 30_000);
    expect(await react(storage, tapback("t4", "Liked", LINE_ABOVE), NOW + 31_000)).toBe("noted");
  });
});

describe("a thumbs up on an ask, in a group", () => {
  const LINE = "+15555550199";
  const ADA = "+15555550101";
  const BO = "+15555550102";
  const GROUP = "11111111-2222-3333-4444-555555555555";
  const groupAsk = ASK.replace("say yes", "reply yes");
  const msg = (text: string, extra: Partial<GroupMessage> = {}): GroupMessage => ({
    kind: "group-message",
    eventId: `sendblue:${extra.messageId ?? "in"}`,
    groupId: GROUP,
    line: LINE,
    from: ADA,
    participants: [ADA, BO, LINE],
    messageId: extra.messageId ?? "in",
    text,
    ...extra,
  });
  function groupDeps(asks: Record<string, unknown>[], clock: { now: number }, answer: unknown): GroupDeps {
    const fetcher = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.startsWith("/api/v2/groups/")) return Response.json({ participants: [{ number: ADA }, { number: BO }] });
      const body = JSON.parse(String(init.body));
      if (path === "/agent-texts/group") return Response.json({ status: "ready", slug: "band", intro: false, handle: "ada", accessToken: "cat" });
      if (path === "/agent") {
        asks.push(body);
        return Response.json(answer);
      }
      return Response.json({ message_handle: `out_${asks.length}` });
    }) as unknown as Fetch;
    return { fetch: fetcher, controlPlaneOrigin: "https://c.test", workerSecret: "s", gatewayOrigin: "https://g.test", sendblue: { keyId: "i", secret: "k" }, now: () => clock.now };
  }

  it("reads a like on an ask from the group webhook", () => {
    const parsed = parseSendblueGroup({
      message_handle: "h2",
      is_outbound: false,
      from_number: ADA,
      sendblue_number: LINE,
      service: "iMessage",
      content: `Liked “${groupAsk}”`,
      group_id: GROUP,
      participants: [ADA, BO],
    });
    expect(parsed).toMatchObject({ kind: "group-message", reaction: { how: "Liked", words: groupAsk } });
    expect(parseSendblueGroup({ message_handle: "h3", is_outbound: false, from_number: ADA, sendblue_number: LINE, service: "iMessage", content: "Liked “lol”", group_id: GROUP })).toEqual({
      kind: "ignored",
      reason: "reaction",
    });
  });

  it("only the asker's like, held ten seconds, goes, with the ask's words", async () => {
    const storage = new MemoryStorage();
    const asks: Record<string, unknown>[] = [];
    const clock = { now: 0 };
    await acceptGroup(storage, msg("Tex, email Jo that Thursday works"), 0);
    await drainGroup(storage, groupDeps(asks, clock, { answer: groupAsk, verbatim: [groupAsk] }));
    const like = (from: string, id: string, removed = false) =>
      msg(`Liked “${groupAsk}”`, { from, messageId: id, reaction: { how: "Liked", words: groupAsk, ...(removed ? { removed: true as const } : {}) } });
    expect(await acceptGroup(storage, like(BO, "bo"), 1_000)).toBe("ignored");
    expect(await acceptGroup(storage, like(ADA, "ada"), 1_000)).toBe("queued");
    clock.now = 1_000 + THUMB_HOLD_MS - 1;
    await drainGroup(storage, groupDeps(asks, clock, { answer: "Sent." }));
    expect(asks).toHaveLength(1);
    clock.now = 1_000 + THUMB_HOLD_MS;
    await drainGroup(storage, groupDeps(asks, clock, { answer: "Sent." }));
    expect(asks).toHaveLength(2);
    expect(asks[1]).toMatchObject({ question: "👍", quoted: groupAsk, tapback: "Liked" });
  });

  it("a like taken back in time sends nothing", async () => {
    const storage = new MemoryStorage();
    const asks: Record<string, unknown>[] = [];
    const clock = { now: 0 };
    await acceptGroup(storage, msg("Tex, email Jo that Thursday works"), 0);
    await drainGroup(storage, groupDeps(asks, clock, { answer: groupAsk, verbatim: [groupAsk] }));
    await acceptGroup(storage, msg("Liked", { messageId: "l", reaction: { how: "Liked", words: groupAsk } }), 1_000);
    await acceptGroup(storage, msg("Removed", { messageId: "r", reaction: { how: "Liked", words: groupAsk, removed: true } }), 5_000);
    clock.now = 60_000;
    await drainGroup(storage, groupDeps(asks, clock, { answer: "Sent." }));
    expect(asks).toHaveLength(1);
  });
});
