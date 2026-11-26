/**
 * A GROUP'S SLOW ASK GETS NO TAPBACK FROM CODE (Dev2, 2026-11-26: "if tex knows its about to take a while to respond
 * to something then it shouldn't really do a tapback but rather it should tell the user something along the lines of
 * 'on it'"). From 2026-11-12 to 2026-11-26 the first tool a turn started tapped the asked message (`toolStarted`);
 * now Tex texts a short line of its own first (`text_progress`, taught by Training), and the only tapbacks left are
 * Tex's own pick for a turn that ends with no words, never beside a line it texted.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. The tool-start tapback put back (`onStep` taps the asked message) → "a tool turn gets no tapback ..." fails.
 *  2. The `acked` check dropped from the tapback ending → "a progress line already said Tex is on it ..." fails.
 *  3. A tapback at accept on any message naming Tex, as the old timer armed it → "a message the judge silenced gets none" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { LINES, fakeJudge, setup, silent, type Answer, type Decide } from "./groupWorld.testing";
import { withIntro } from "./groupModelTurn";
import type { Fetch } from "./clients";
import { unwritten } from "./events";

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
    it("a tool turn gets no tapback from code, only its reply", async () => {
      const storage = new MemoryStorage();
      const w = streaming(groupId, [{ step: "web_search" }, { step: "web_fetch" }, { step: "web_search" }], { answer: "Nopa at 7." });
      await bound(storage, w);
      await acceptGroup(storage, w.message("Tex, where should we eat Friday?"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toEqual([]);
      expect(w.texts).toEqual(["Nopa at 7."]);
    });

    it("a slow ask's own short line goes first, then the answer, with no tapback", async () => {
      const storage = new MemoryStorage();
      const w = streaming(groupId, [{ progress: "Checking now." }, { step: "web_search" }], { answer: "Nopa at 7." });
      await bound(storage, w);
      await acceptGroup(storage, w.message("Tex, where should we eat Friday?"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toEqual([]);
      expect(w.texts).toEqual(["Checking now.", "Nopa at 7."]);
    });

    // Dev2, 2026-11-15: "The Text them node doesnt seem to be logging the actual time it takes": a group's texts are
    // handed to its line here, after the gateway answered, so that time is the turn's own `send` step.
    it("the answer's delivery is kept as a send step under the turn, with its time", async () => {
      const storage = new MemoryStorage();
      const w = streaming(groupId, [], { answer: "Nopa at 7." });
      await bound(storage, w);
      await acceptGroup(storage, w.message("Tex, where should we eat Friday?"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual(["Nopa at 7."]);
      const all = [...w.posted(), ...(await unwritten(storage))];
      const kept = all.filter((event) => event.kind === "step" && event.step?.name === "send");
      const said = all.filter((event) => event.from.kind === "tex" && event.text === "Nopa at 7.").at(-1);
      expect(typeof said?.turn).toBe("string");
      expect(kept.at(-1)).toMatchObject({ turn: said!.turn, step: { of: "delivery", ok: true, input: { parts: 1 }, output: { sent: 1 } } });
      expect(kept.at(-1)!.step!.ms).toBeGreaterThanOrEqual(0);
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

    // Dev2, 2026-11-17, "Front door picks the tapback": a turn that ends with only Tex's own tapback
    // (`packages/tex/gateway/agent/tapbackEnding.js`) gets that one, once.
    it("Tex's own tapback ending goes once, as Tex picked it", async () => {
      const storage = new MemoryStorage();
      const w = streaming(groupId, [{ step: "write" }], { answer: "", quiet: true, react: "🎉" });
      await bound(storage, w);
      await acceptGroup(storage, w.message("Tex, put the party on the calendar for Saturday"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toEqual(["🎉"]);
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
      const w = streaming(groupId, [{ progress: "On it, checking their sites." }, { step: "browse" }], { answer: "", quiet: true, react: "👍" });
      await bound(storage, w);
      await acceptGroup(storage, w.message("Tex, book the 7pm"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toEqual([]);
      expect(w.texts).toEqual(["On it, checking their sites."]);
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
