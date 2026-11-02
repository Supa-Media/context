/**
 * Where a group reply's time goes, fixed lines included (`timedReply` in
 * `groupSay.ts`). "Tex, settings" took four minutes on 2026-10-30 and is
 * answered without the gateway, so the model turn's timing never saw it.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `clock?.mark("control")` removed from `answerGroup`: the control plane's
 *    four minutes land in `replyMs` and "a settings reply handed to its
 *    workflow" fails;
 *  - `timedReply` dropped from `answerHanded`: no line, the same test fails;
 *  - `fixedTimings` leaving the kept timings in place: "rides on the chat's
 *    next model turn, once" fails on the second turn.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { LINES, setup } from "./groupWorld.testing";
import { answerHanded, TURN_KEY, type HandedTurn } from "./groupTurnRun";

afterEach(() => vi.restoreAllMocks());

function timings(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : {})).filter((line) => line.event === "group_reply_timing");
}

const { groupId } = LINES[0];

describe("a group reply's timing", () => {
  it("a settings reply handed to its workflow: queue, workflow start, control plane and reply apart", async () => {
    let t = 0;
    const storage = new MemoryStorage();
    // The control plane's check is the slow part here: four minutes, less the rest.
    const w = setup(groupId, { controlFor: () => void (t += 230_000) });
    const deps = { ...w.deps, now: () => t, startTurn: async () => {} };
    const spy = vi.spyOn(console, "log");
    await acceptGroup(storage, w.message("Tex, settings"), 0);
    t = 2_000;
    await drainGroup(storage, deps);
    const turn = (await storage.get<HandedTurn>(TURN_KEY))!;
    t = 10_000;
    expect(await answerHanded(storage, deps, turn.id)).toBe("done");
    expect(w.texts[0]).toMatch(/^My settings here:/);
    expect(timings(spy)).toEqual([{ event: "group_reply_timing", path: "settings", outcome: "done", queueMs: 2_000, startMs: 8_000, membersMs: 0, controlMs: 230_000, replyMs: 0, totalMs: 240_000 }]);
    // Numbers and a path name only: never the words or who sent them.
    expect(JSON.stringify(timings(spy))).not.toMatch(/settings here|Tex, settings|\+1/);
  });

  it("a settings reply's timing rides on the chat's next model turn, once, for the chat's note", async () => {
    let t = 0;
    const storage = new MemoryStorage();
    const w = setup(groupId);
    const deps = { ...w.deps, now: () => t };
    await acceptGroup(storage, w.message("Tex, settings"), 0);
    t = 4_000;
    await drainGroup(storage, deps);
    await acceptGroup(storage, w.message("Tex what's on tonight"), 10_000);
    t = 12_000;
    await drainGroup(storage, deps);
    expect(w.asks[0]!.fixed).toEqual([{ path: "settings", arrivedAt: 0, sentAt: 4_000, queueMs: 4_000, membersMs: 0, controlMs: 0, replyMs: 0 }]);
    await acceptGroup(storage, w.message("Tex and tomorrow"), 20_000);
    t = 21_000;
    await drainGroup(storage, deps);
    expect(w.asks[1]).not.toHaveProperty("fixed");
  });

  it("a reply answered here has no workflow start, and a model turn is a turn", async () => {
    let t = 0;
    const storage = new MemoryStorage();
    const w = setup(groupId);
    const deps = { ...w.deps, now: () => t };
    const spy = vi.spyOn(console, "log");
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    t = 3_000;
    await drainGroup(storage, deps);
    const [line] = timings(spy);
    expect(line).toMatchObject({ path: "turn", outcome: "done", queueMs: 3_000, totalMs: 3_000 });
    expect(line).not.toHaveProperty("startMs");
  });
});
