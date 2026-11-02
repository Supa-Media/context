/**
 * A group's member list read at a turn's start and again before its answer
 * (2026-11-02, `docs/decisions/texting-assistant/groups.md`): a failed read at
 * the start retries a question on every app, while a command on Sendblue is
 * answered from the webhook's names; one failed read before the answer is
 * tried again before it holds. A list unread twice and a real
 * newcomer still hold it (`groupInbox.test.ts`, `groupProgress.test.ts`).
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { ADA, BO, LINE, LINES, setup } from "./groupWorld.testing";
import { GROUP_LINES } from "./groupLines";

for (const { name, groupId } of LINES) {
  describe(`a group's member reads, ${name}`, () => {
    it("retry a turn whose list can't be read at the start, so a member the webhook named by email is no newcomer", async () => {
      // Read later, Bo's phone stands for the email handle the webhook gave: had the turn gone on the webhook's names
      // alone, the answer's read would have held it for a joiner nobody was.
      const storage = new MemoryStorage();
      const w = setup(groupId, { members: [null, [ADA, BO]] });
      await acceptGroup(storage, w.message("Tex, hi", { participants: [ADA, "bo@icloud.example", LINE] }), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual([]);
      expect(w.control).toEqual([]);
      expect((await storage.list({ prefix: "gpending:" })).size).toBe(1);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual(["answer to Tex, hi"]);
    });

    it("read again before holding the answer on one failed read", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { members: [[ADA, BO], null, [ADA, BO]] });
      await acceptGroup(storage, w.message("Tex, hi"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual(["answer to Tex, hi"]);
    });
  });
}

describe("an iMessage group whose members can't be read", () => {
  const groupId = LINES[0].groupId;
  const stops = (body: Record<string, unknown>) => ((body.command as { kind?: string } | undefined)?.kind === "stop" ? { status: "stopped" } : undefined);

  it("is still stopped by \"Tex, stop\", on the webhook's names", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, { members: [null], controlFor: stops });
    await acceptGroup(storage, w.message("Tex, stop"), 0);
    await drainGroup(storage, w.deps);
    expect(w.control.map((body) => body.command)).toEqual([{ kind: "stop" }]);
    expect(w.texts).toEqual([GROUP_LINES.stopped]);
    expect((await storage.list({ prefix: "gpending:" })).size).toBe(0);
  });

  it("is not told which workspaces it shares until the list reads", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, { members: [null] });
    await acceptGroup(storage, w.message("Tex, what can you see"), 0);
    await drainGroup(storage, w.deps);
    expect(w.control).toEqual([]);
    expect(w.texts).toEqual([]);
  });
});
