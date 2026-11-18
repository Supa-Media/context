import { describe, expect, it } from "vitest";
import { bubblesUnder, readUnder } from "./bubblesUnder";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { keptEvents } from "./events";
import { GROUP, message, deps, world } from "./groupInboxWorld.testing";

// The Battle of the Bots chat, 2026-11-17: "tex, say alpha" and "tex, say bravo" were answered in one turn, and both
// bubbles went under "say bravo" (Dev2 chose, 2026-11-18: each bubble under its own text).
const A = "0000000000001-000001";
const B = "0000000000002-000002";

describe("each part of a group answer under the text it answers", () => {
  it("keeps the gateway's parts only when they are the answer's own words, in order", () => {
    expect(readUnder([{ under: A, text: "alpha" }, { under: B, text: "bravo" }], "alpha\n\nbravo")).toEqual([{ under: A, text: "alpha" }, { under: B, text: "bravo" }]);
    expect(readUnder([{ text: "Both." }, { under: B, text: "bravo" }], "Both.\n\nbravo")).toEqual([{ text: "Both." }, { under: B, text: "bravo" }]);
    // Not the answer: nothing is threaded on a guess.
    expect(readUnder([{ under: A, text: "alpha" }], "alpha\n\nbravo")).toEqual([]);
    expect(readUnder([{ under: "not-an-event", text: "alpha" }], "alpha")).toEqual([]);
    expect(readUnder("alpha", "alpha")).toEqual([]);
  });

  it("cuts each part into its own bubbles, under the message of the text it names", () => {
    const messages = { [A]: "m_alpha", [B]: "m_bravo" };
    expect(bubblesUnder("alpha\n\nbravo", [{ under: A, text: "alpha" }, { under: B, text: "bravo" }], messages)).toEqual([
      { text: "alpha", messageId: "m_alpha" },
      { text: "bravo", messageId: "m_bravo" },
    ]);
    // A part with no text named, or a text this turn did not answer, goes where the answer always went.
    expect(bubblesUnder("Both.\n\nbravo", [{ text: "Both." }, { under: "0000000000009-000009", text: "bravo" }], messages)).toEqual([{ text: "Both." }, { text: "bravo" }]);
    // No parts, or a check-in's one bubble: as before.
    expect(bubblesUnder("alpha\n\nbravo", [], messages)).toEqual([{ text: "alpha" }, { text: "bravo" }]);
  });

  it("threads alpha under 'say alpha' and bravo under 'say bravo' in the chat, and logs where each went", async () => {
    const storage = new MemoryStorage();
    const w = world();
    // A chat Tex is set up in.
    await acceptGroup(storage, message("Tex, hi", { eventId: "sendblue:hi", messageId: "hi" }), 0);
    await drainGroup(storage, deps(w));
    await acceptGroup(storage, message("tex, say alpha", { eventId: "sendblue:a", messageId: "m_alpha" }), 1_000);
    await acceptGroup(storage, message("tex, say bravo", { eventId: "sendblue:b", messageId: "m_bravo" }), 1_100);
    // The gateway answers the turn's two texts by their event ids, as `replyUnder.js` does.
    const agent = {
      answer: "alpha\n\nbravo",
      get under() {
        const covers = (w.asks.at(-1) as { covers: string[] }).covers;
        return [{ under: covers.at(-2), text: "alpha" }, { under: covers.at(-1), text: "bravo" }];
      },
    };
    w.sends.length = 0;
    const d = deps(w, { agent });
    const posted: { from?: { kind: string }; text?: string; replyTo?: string }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === "/agent/events") posted.push(...JSON.parse(String(init.body)).events);
      return d.fetch(url, init);
    }) as typeof d.fetch;
    await drainGroup(storage, { ...d, fetch, now: () => 1_200 });
    expect((w.asks.at(-1) as { covers: string[] }).covers).toHaveLength(2);
    expect(w.sends.map((sent) => [sent.content, sent.reply_to])).toEqual([
      ["alpha", { message_handle: "m_alpha" }],
      ["bravo", { message_handle: "m_bravo" }],
    ]);
    const covers = (w.asks.at(-1) as { covers: string[] }).covers;
    const tex = [...posted, ...(await keptEvents(storage, GROUP))].filter((event) => event.from?.kind === "tex" && (event.text === "alpha" || event.text === "bravo"));
    expect(tex.map((event) => [event.text, event.replyTo])).toEqual([["alpha", covers[0]], ["bravo", covers[1]]]);
  });
});
