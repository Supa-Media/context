/**
 * A change Tex made to a group (`groupRun.ts`) is kept in the chat's record as Tex's own line (2026-11-24, a Lab
 * eval): a turn that only renamed the chat texted nothing, the next turn read "rename this chat" as unanswered and
 * renamed it again beside the poll it was asked for.
 *
 * Sabotage record (2026-11-24): drop the `logOut` of `ran.done` in `groupModelTurn.ts` and "the next turn is shown
 * the rename" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import type { GroupLine } from "./groupLine";
import { recentEvents } from "./events";
import { MemoryStorage } from "./memoryStorage.testing";
import { ADA, BO, fakeJudge, LINES, setup } from "./groupWorld.testing";

const { groupId } = LINES[0];

/** A line that can run the group, keeping what it was asked. */
function runningLine(ran: unknown[], texts: string[]): GroupLine {
  return {
    sendText: async (_place, text) => (texts.push(text), `out_${texts.length}`),
    sendMedia: async () => {},
    runGroup: async (_place, action) => void ran.push(action),
    react: async () => {},
    readMembers: async () => [ADA, BO],
    readOwnMessage: async () => null,
  };
}

describe("running the group is kept in the chat's record", () => {
  it("the next turn is shown the rename, though no words went", async () => {
    const storage = new MemoryStorage();
    const ran: unknown[] = [];
    const texts: string[] = [];
    const w = setup(groupId, { decide: fakeJudge, agent: () => ({ answer: "(name the chat) Launch Crew", texts: ["(name the chat) Launch Crew"] }) });
    const deps = { ...w.deps, remoteGroupLine: () => runningLine(ran, texts) };
    await acceptGroup(storage, w.message("Tex rename this chat to Launch Crew"), 0);
    await drainGroup(storage, deps);
    expect(ran).toEqual([{ kind: "name", name: "Launch Crew" }]);
    expect(texts).toEqual([]);
    const all = [...(await recentEvents(storage, groupId)), ...w.posted()];
    const kept = all.filter((event) => event.from.kind === "tex" && event.kind === "text");
    expect(kept.map((event) => event.text)).toEqual(["(named the chat “Launch Crew”)"]);
    expect(kept[0]!.delivered).toBe(true);
    expect(kept[0]!.covers?.length).toBeGreaterThan(0);
  });
});
