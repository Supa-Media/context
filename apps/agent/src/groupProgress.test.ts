/**
 * A group turn's progress lines (Dev2, 2026-11-01,
 * `docs/decisions/texting-assistant/interleaved-updates.md`): as many as the
 * turn sends, in order, each logged as Tex's, and only while nobody new is
 * here. Threading under the ask is `groupInbox.test.ts`'s; a retry is
 * `groupTurnWorkflow.test.ts`'s.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { ADA, BO, CY, LINES, setup } from "./groupWorld.testing";
import { recentEvents } from "./events";
import type { Fetch } from "./clients";

/** The chat's world, its turn streaming `lines` and then `answer`. */
function streaming(groupId: string, lines: string[], answer: string, members?: string[][]) {
  const w = setup(groupId, { members });
  const fetch = w.deps.fetch;
  w.deps.fetch = (async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname !== "/agent") return await fetch(url, init);
    const out = [...lines.map((progress) => ({ progress })), { status: 200, body: { answer } }];
    return new Response(out.map((line) => JSON.stringify(line)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
  }) as unknown as Fetch;
  return w;
}

for (const { name, groupId } of LINES) {
  describe(`a group turn's progress lines, ${name}`, () => {
    it("are texted in order, each its own bubble, logged as Tex's under the turn", async () => {
      const storage = new MemoryStorage();
      const w = streaming(groupId, ["Checking OpenTable for Friday.", "Found 3 tables at Nopa.", "Reading their reviews."], "Nopa at 7, want it?");
      await acceptGroup(storage, w.message("Tex, find us a table Friday"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual(["Checking OpenTable for Friday.", "Found 3 tables at Nopa.", "Reading their reviews.", "Nopa at 7, want it?"]);
      const log = (await recentEvents(storage, groupId)).filter((event) => event.from.kind === "tex");
      expect(log.map((event) => [event.text, event.delivered])).toEqual([["Checking OpenTable for Friday.", true], ["Found 3 tables at Nopa.", true], ["Reading their reviews.", true], ["Nopa at 7, want it?", true]]);
      expect(log.every((event) => event.turn !== undefined && event.turn === log[0].turn)).toBe(true);
    });

    it("pause for good once someone new joins, each held line logged as held", async () => {
      const storage = new MemoryStorage();
      // Here when it starts and at the first line; Cy joins before the second, and has left again by the third.
      const w = streaming(groupId, ["Reading the page now.", "Found the pricing table.", "Comparing the plans."], "Plan B fits.", [[ADA, BO], [ADA, BO], [ADA, BO, CY], [ADA, BO]]);
      await acceptGroup(storage, w.message("Tex, research this"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts[0]).toBe("Reading the page now.");
      expect(w.texts).not.toContain("Found the pricing table.");
      expect(w.texts).not.toContain("Comparing the plans.");
      const held = (await recentEvents(storage, groupId)).filter((event) => event.reason === "held_newcomer").map((event) => event.text);
      expect(held).toEqual(["Found the pricing table.", "Comparing the plans."]);
    });
  });
}
