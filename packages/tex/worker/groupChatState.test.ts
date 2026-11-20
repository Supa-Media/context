/**
 * The chat's state in a running group (`chatState.ts`, Dev2 2026-11-01):
 * the phases a turn goes through, and the redraft cap holding a restart.
 *
 * Sabotage (temporary local edit, reverted): `whileRunning` restarting without
 * asking `chatEvent(..., "redraft")` first: "past MAX_REDRAFTS a restart is folded" fails.
 */
import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { CHAT_STATE_KEY, MAX_REDRAFTS, readChatState, type ChatState } from "./chatState";
import { answerAll, LINES, setup } from "./groupWorld.testing";

for (const { name, groupId } of LINES) {
  describe(`the chat's state, ${name}`, () => {
    it("a turn goes idle, drafting, sending and back to idle", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      const logs: string[] = [];
      const log = console.log;
      console.log = (line: string) => void logs.push(line);
      try {
        await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
        await drainGroup(storage, w.deps);
      } finally {
        console.log = log;
      }
      const moves = logs.flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as { event?: string; from?: string; to?: string };
          return parsed.event === "chat_state" ? [`${parsed.from}>${parsed.to}`] : [];
        } catch {
          return [];
        }
      });
      expect(moves).toEqual(["idle>drafting", "drafting>sending", "sending>idle"]);
      expect(await readChatState(storage)).toMatchObject({ phase: "idle", waits: 0, redrafts: 0 });
    });

    it("past MAX_REDRAFTS a restart is folded into the running turn, never another cancel", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { hold: true, decide: (body) => (body.running ? { ...answerAll(body), midTurn: "restart" } : answerAll(body)) });
      // A burst that has already been redrafted as often as allowed.
      await storage.put<ChatState>(CHAT_STATE_KEY, { phase: "idle", version: 0, waits: 0, redrafts: MAX_REDRAFTS });
      await acceptGroup(storage, w.message("Tex make a graphic"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      await acceptGroup(storage, w.message("Tex no, a poster"), 10);
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.cancels).toEqual([]);
    });
  });
}

describe("the fast path in every phase", () => {
  it("a command behind a burst decide is holding is answered now", async () => {
    const storage = new MemoryStorage();
    const w = setup(LINES[0].groupId, { decide: () => ({ ok: true, act: "wait", covers: [], stale: [], movedOn: false, confidence: 0.9, waitSeconds: 6 }), control: { engagement: "helpful", engagementChosen: true } });
    await acceptGroup(storage, w.message("Tex hi"), 0);
    await drainGroup(storage, w.deps);
    w.texts.length = 0;
    await acceptGroup(storage, w.message("so about friday"), 100);
    w.deps.now = () => 200;
    await drainGroup(storage, w.deps);
    expect(await readChatState(storage)).toMatchObject({ phase: "gathering" });
    await acceptGroup(storage, w.message("Tex, stop"), 300);
    w.deps.now = () => 400;
    await drainGroup(storage, w.deps);
    expect(w.control.at(-1)).toMatchObject({ command: { kind: "stop" } });
  });
});
