/**
 * A GROUP'S SLOW ASK GETS ONE TAPBACK, AS ITS FIRST TOOL STARTS (`groupModelTurn.ts` `toolStarted`,
 * `apps/mcp/src/agent/turn.js` `onToolStart`; Dev2, 2026-11-12). It replaced the 25 s timer tapback, which landed
 * after most answers (12 to 26 s) and fired on messages the judge silenced. A turn with no tool (about 12 s) gets
 * none, and Tex never pairs it with a text acknowledgement.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `toolStarted` without its `acked` check → "two tool calls still give one tapback" fails.
 *  2. `onStep` left out of the `askAgentStream` call → "a tool turn gets exactly one tapback, before the reply" fails.
 *  3. A tapback at accept on any message naming Tex, as the old timer armed it → "a message the judge silenced gets none" fails.
 *  4. `toolStarted` on every step and on a turn's end (a no-tool turn tapped) → "a turn with no tool gets none" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { LINES, fakeJudge, setup, silent, type Answer, type Decide } from "./groupWorld.testing";
import { withIntro } from "./groupModelTurn";
import type { Fetch } from "./clients";

/** The chat's world, its turn streaming `lines` and then `body`; `tapsAt` is how many texts had gone out at each tapback. */
function streaming(groupId: string, lines: Record<string, unknown>[], body: Record<string, unknown>, decide: (body: Decide) => Answer = fakeJudge) {
  const w = setup(groupId, { decide }); // by default the judge answers a message naming Tex and silences the rest
  const fetch = w.deps.fetch;
  const tapsAt: number[] = [];
  const turns: unknown[] = [];
  w.deps.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/send-reaction" || path.endsWith("/reaction")) tapsAt.push(w.texts.length);
    if (path !== "/agent") return await fetch(url, init);
    turns.push(init?.body);
    const out = [...lines, { status: 200, body }];
    return new Response(out.map((line) => JSON.stringify(line)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
  }) as unknown as Fetch;
  return { ...w, tapsAt, turns };
}

/** Binds the chat with a first answer, so the next message is an ordinary turn. */
async function bound(storage: MemoryStorage, w: ReturnType<typeof streaming>): Promise<void> {
  await acceptGroup(storage, w.message("Tex, hi"), 0);
  await drainGroup(storage, w.deps);
  w.texts.length = 0;
  w.reactions.length = 0;
  w.tapsAt.length = 0;
  w.turns.length = 0;
}

for (const { name, groupId } of LINES) {
  describe(`a group's slow ask, ${name}`, () => {
    it("a tool turn gets exactly one tapback, before the reply", async () => {
      const storage = new MemoryStorage();
      const w = streaming(groupId, [{ step: "web_search" }], { answer: "Nopa at 7." });
      await bound(storage, w);
      await acceptGroup(storage, w.message("Tex, where should we eat Friday?"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toHaveLength(1);
      expect(w.tapsAt).toEqual([0]);
      expect(w.texts).toEqual(["Nopa at 7."]);
    });

    it("two tool calls still give one tapback", async () => {
      const storage = new MemoryStorage();
      const w = streaming(groupId, [{ step: "web_search" }, { step: "web_fetch" }, { step: "web_search" }], { answer: "Nopa at 7." });
      await bound(storage, w);
      await acceptGroup(storage, w.message("Tex, where should we eat Friday?"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toHaveLength(1);
    });

    it("a tool turn that starts a job with a tapback still gives one", async () => {
      const storage = new MemoryStorage();
      const w = streaming(groupId, [{ step: "send" }], { answer: "", quiet: true, react: "" });
      await bound(storage, w);
      await acceptGroup(storage, w.message("Tex, research venues for the party"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toHaveLength(1);
      expect(w.texts).toEqual([]);
    });

    it("a turn with no tool gets none, answered or silent", async () => {
      for (const body of [{ answer: "18% of 250 is 45." }, { answer: "", quiet: true }]) {
        const storage = new MemoryStorage();
        const w = streaming(groupId, [], body);
        await bound(storage, w);
        await acceptGroup(storage, w.message("Tex, what's 18% of 250?"), 1_000);
        await drainGroup(storage, w.deps);
        expect(w.reactions).toEqual([]);
      }
    });

    it("a progress line already said Tex is on it: no tapback with it", async () => {
      const storage = new MemoryStorage();
      const w = streaming(groupId, [{ progress: "Here's the sign-in link: https://example.test/a" }, { step: "browse" }], { answer: "Booked." });
      await bound(storage, w);
      await acceptGroup(storage, w.message("Tex, book the 7pm"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toEqual([]);
    });

    it("a message the judge silenced gets none, though it names Tex", async () => {
      const storage = new MemoryStorage();
      let first = true;
      const w = streaming(groupId, [{ step: "web_search" }], { answer: "never asked" }, (body) => (first ? ((first = false), fakeJudge(body)) : silent()));
      await bound(storage, w);
      await acceptGroup(storage, w.message("Tex is so funny lol"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.turns).toEqual([]); // no turn ran
      expect(w.reactions).toEqual([]);
    });
  });
}

describe("the intro on the first answer", () => {
  it("is the last text's last line; a bare link and an exact text stay as they are, with the intro after them", () => {
    expect(withIntro(["Here it is"], "I'm Tex.")).toEqual(["Here it is\n\nI'm Tex."]);
    expect(withIntro(["Here it is", "https://context.lc/p/x"], "I'm Tex.")).toEqual(["Here it is", "https://context.lc/p/x", "I'm Tex."]);
    expect(withIntro(["Draft below", "Send this?"], "I'm Tex.", ["Send this?"])).toEqual(["Draft below", "Send this?", "I'm Tex."]);
    expect(withIntro([], "I'm Tex.")).toEqual([]);
    expect(withIntro(["Hi"], null)).toEqual(["Hi"]);
  });
});
