import { afterEach, describe, expect, it, vi } from "vitest";

import { groupLineFor, type GroupLine } from "./groupLine";
import { lineFor, type Line } from "./line";
import { guardedLine, maySend, outboundDrop, sentinelOf } from "./outboundGuard";
import { sendWords, type PartLine } from "./sendOne";

// Invented words in the shape of the leak (2026-11-17): a check-in's reasoning, then the quiet word.
const LEAK = "Nothing new in the shared folder since 5:52 PM, and nobody here is waiting on an answer. Nothing needs the group now. SKIP";

afterEach(() => vi.restoreAllMocks());

describe("the last guard before a text leaves", () => {
  it("drops any text whose decision is skip or quiet, whatever its words", () => {
    for (const decision of ["skip", "quiet", "say_nothing", "SKIP", "skipped"]) expect(outboundDrop("Dinner is at 7.", decision)).toBe("decision");
    expect(outboundDrop("Dinner is at 7.", "send")).toBeNull();
    expect(outboundDrop("Dinner is at 7.")).toBeNull();
    expect(outboundDrop("Dinner is at 7.", null)).toBeNull();
  });

  it("drops a bare quiet word", () => {
    for (const text of ["SKIP", "skip", " SKIP. ", "**SKIP**", "`SKIP`", "(SKIP)", "Skipped", "NO_REPLY", "NOOP"]) expect(sentinelOf(text), text).toBe("control_word");
  });

  it("drops reasoning that ends with the quiet word", () => {
    for (const text of [
      LEAK,
      "No new mail, and no follow-up is owed.\n\nSKIP",
      "No new mail, and no follow-up is owed.\nSKIP.",
      "Nothing needs the chat now SKIP",
      "Nothing to post - SKIP",
      "Nothing to post — SKIP",
      "Nothing to post: SKIP",
      "Nothing to post. **SKIP**",
      "Nothing to post.\n`SKIP`",
      "Nothing to post. (SKIP)",
      'Nothing to post. "SKIP"',
      "Nothing new since the last look.\n\nSkip",
      "Nothing new since the last look.\n\nskip.",
      "Nothing new since the last look.SKIP",
    ])
      expect(sentinelOf(text), text).toBe("trailing_sentinel");
  });

  it("drops a quiet word that opens its own explanation", () => {
    for (const text of ["SKIP. Rent isn't due this week.", "SKIP - nothing new in the mailbox", "SKIP: no new mail", "SKIP\nNothing new since 5:52 PM.", "SKIP — nothing to add"]) expect(sentinelOf(text), text).toBe("leading_sentinel");
  });

  it("lets a text through that only uses the word", () => {
    for (const text of [
      "Want me to skip the Tuesday one?",
      "You can skip.",
      "We could skip",
      "Bo, can you be home, or should we skip this week?",
      "I'd skip it.\nWant the short version instead?",
      "Tap SKIP in the top corner to pass the intro.",
      "SKIP the queue with a fast pass; it's $20.",
      "Skip the first two steps, then run it.",
      "Skipping today's standup, as you asked.",
      "The SKIPPER called about the boat.",
      "SKIPPED the charge; nothing was taken.",
      "It was a hop, a skip and a jump away",
      "Their handle is @skip",
      "Your options:\n- wait\n- skip",
      "Two choices.\nReschedule\nSkip",
      "The file is named NOSKIP",
      "Their handle is @SKIP",
      "Use the tag #SKIP",
      "It lives at docs/SKIP",
      "Nothing needs the group now.",
      "",
    ])
      expect(sentinelOf(text), text).toBeNull();
  });

  it("logs a drop with its reason and lane, and never the words", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(maySend(LEAK, "group")).toBe(false);
    expect(maySend("Dinner is at 7.", "group")).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({ event: "outbound_dropped", reason: "trailing_sentinel", lane: "group" });
    expect(line).not.toContain("Nothing");
  });
});

describe("every line is behind the guard", () => {
  const stubFetch = () => vi.fn(async () => new Response(JSON.stringify({ sent: true, message: { id: "wamid.1" }, message_handle: "h1", status: "QUEUED", id: "m1" }), { status: 200, headers: { "content-type": "application/json" } }));
  const sendblue = { keyId: "key", secret: "secret", line: "+15555550100" } as never;
  const whapi = { token: "token", line: "+15555550101" } as never;

  // One chat per line: Linq, Sendblue (iMessage), WhatsApp. A dropped text never reaches the provider.
  it.each([
    ["linq", "chat_123"],
    ["sendblue", "sendblue:+15555550100:+15555550123"],
    ["whatsapp", "whapi:+15555550101:+15555550123"],
  ])("a 1:1 %s line never sends a skip, and still sends a text", async (_name, chatId) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = stubFetch();
    const line = lineFor({ fetch: fetch as never, linqApiKey: "key", sendblue, whapi }, chatId);
    expect(await line.sendText(chatId, LEAK, "k1")).toBeUndefined();
    expect(await line.sendText(chatId, "SKIP", "k2")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    await line.sendText(chatId, "Want me to skip the Tuesday one?", "k3");
    expect(fetch).toHaveBeenCalled();
  });

  it.each([
    ["sendblue", "group-abc"],
    ["whatsapp", "whapi:120363000000000000@g.us"],
  ])("a %s group line never sends a skip, and still sends a text", async (_name, groupId) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = stubFetch();
    const line = groupLineFor({ fetch: fetch as never, sendblue, whapi }, groupId);
    const place = { line: "+15555550100", groupId };
    expect(await line.sendText(place, LEAK)).toBeUndefined();
    expect(await line.sendText(place, "No new mail.\n\nSKIP")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    await line.sendText(place, "The plumber moved Thursday's visit to Friday at 9.");
    expect(fetch).toHaveBeenCalled();
  });

  it("a line served from elsewhere (Photon's, the gateway's remote line) is guarded too", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sent: string[] = [];
    const remote = { sendText: async (_where: unknown, text: string) => (sent.push(text), "h") } as unknown as Line & GroupLine;
    await lineFor({ fetch: fetch as never, linqApiKey: "", remote: () => remote }, "any:chat").sendText("any:chat", LEAK, "k");
    await groupLineFor({ fetch: fetch as never, remote: () => remote }, "any-group").sendText({ line: "+15555550100", groupId: "any-group" }, LEAK);
    expect(sent).toEqual([]);
    await groupLineFor({ fetch: fetch as never, remote: () => remote }, "any-group").sendText({ line: "+15555550100", groupId: "any-group" }, "Dinner is at 7.");
    expect(sent).toEqual(["Dinner is at 7."]);
  });

  it("keeps the rest of the line as it was", async () => {
    const react = vi.fn(async () => {});
    const line = guardedLine({ sendText: async (_where: never, text: string) => text, react }, "group");
    expect(line.react).toBe(react);
  });
});

describe("the one sender", () => {
  const partLine = () => {
    const went: string[] = [];
    const logged: unknown[] = [];
    const line: PartLine<never> = {
      sendText: async (text) => (went.push(text), "h"),
      sendPicture: async () => undefined,
      refused: () => false,
      remember: async () => {},
      log: async (part) => void logged.push(part),
    };
    return { line, went, logged };
  };

  it("sends nothing, and logs nothing as delivered, for a skip or quiet decision or a trailing quiet word", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { line, went, logged } = partLine();
    expect(await sendWords(line, "Dinner is at 7.", "skip")).toBe(false);
    expect(await sendWords(line, "Dinner is at 7.", "quiet")).toBe(false);
    expect(await sendWords(line, LEAK)).toBe(false);
    expect(await sendWords(line, "SKIP")).toBe(false);
    expect(went).toEqual([]);
    expect(logged).toEqual([]);
    expect(await sendWords(line, "Dinner is at 7.", "send")).toBe(true);
    expect(await sendWords(line, "Want me to skip it?")).toBe(true);
    expect(went).toEqual(["Dinner is at 7.", "Want me to skip it?"]);
  });
});
