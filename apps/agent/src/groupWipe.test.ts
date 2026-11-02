/**
 * "TEX, FORGET THIS CHAT" ON THE WORKER (Dev2, 2026-11-02;
 * `docs/decisions/texting-assistant/custom-instructions.md`).
 *
 *  1. Any member's "Tex, forget this chat" goes to the control plane as a
 *     command, and Tex says who cleared it and how to undo it.
 *  2. From the forget point on, a turn is handed no chat line said before it
 *     and decide is shown no event before it; nothing is deleted.
 *  3. The turn names the forget point to the gateway.
 *  4. Every logged message carries a hash of its own id and of the one it
 *     replies to, and Tex's answer the one it is threaded under, so a
 *     reply-back finds its thread in the log.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `chatBefore` ignoring the forget point: "nothing said before the wipe is handed on" fails;
 *  - `keptSince` showing decide every kept event: the same test fails;
 *  - `logOut` dropping the refs: "a reply and Tex's answer carry their thread" fails.
 */
import { describe, expect, it } from "vitest";
import { keptEvents } from "./events";
import { sha256Hex } from "./groupChat";
import { acceptGroup, drainGroup, GROUP_LINES } from "./groupInbox";
import { BO, LINES, setup, untaggedSilent } from "./groupWorld.testing";
import { MemoryStorage } from "./memoryStorage.testing";

for (const { name, groupId } of LINES) {
  describe(`forgetting a group, ${name}`, () => {
    it("nothing said before the wipe is handed on, and the turn names the forget point", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, {
        decide: untaggedSilent,
        control: { wipedAt: 25 },
        controlFor: (body) => ((body.command as { kind?: string } | undefined)?.kind === "forget" ? { status: "forgotten", by: "bo", wipedAt: 25 } : undefined),
      });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("the secret plan", { from: BO }), 20);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("Tex, forget this chat", { from: BO }), 30);
      await drainGroup(storage, w.deps);
      expect(w.control.at(-1)!.command).toEqual({ kind: "forget" });
      expect(w.texts.at(-1)).toBe(GROUP_LINES.forgotten("bo"));
      await acceptGroup(storage, w.message("the new plan", { from: BO }), 40);
      await drainGroup(storage, w.deps);
      expect(w.decided.at(-1)!.transcript).not.toContain("the secret plan");
      expect(w.decided.at(-1)!.transcript).toContain("the new plan");
      await acceptGroup(storage, w.message("Tex sum it up"), 50);
      await drainGroup(storage, w.deps);
      const turn = w.asks.at(-1)! as { group: { wipedAt?: number; chat: { text: string }[] } };
      expect(turn.group.wipedAt).toBe(25);
      expect(turn.group.chat.map((line) => line.text)).toEqual(["the new plan"]);
      // Kept, never deleted: the log still holds it, for an undo.
      expect((await keptEvents(storage, groupId)).some((event) => event.text === "the secret plan")).toBe(true);
    });

    it("an undo too late is said so", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { controlFor: (body) => ((body.command as { kind?: string } | undefined)?.kind === "unforget" ? { status: "unforgotten", outcome: "expired" } : undefined) });
      await acceptGroup(storage, w.message("Tex, undo the wipe"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual([GROUP_LINES.unforgotten.expired]);
    });

    it("a reply and Tex's answer carry their thread", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      await acceptGroup(storage, w.message("Tex what's on tonight", { messageId: "root_1" }), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("Tex and tomorrow?", { messageId: "reply_1", replyTo: "root_1" }), 10);
      await drainGroup(storage, w.deps);
      const events = await keptEvents(storage, groupId);
      const root = events.find((event) => event.text === "Tex what's on tonight")!;
      const reply = events.find((event) => event.text === "Tex and tomorrow?")!;
      const answer = events.find((event) => event.from.kind === "tex" && event.text === "answer to Tex what's on tonight")!;
      expect(root).toMatchObject({ ref: await sha256Hex("root_1") });
      expect(root.replyRef).toBeUndefined();
      expect(reply).toMatchObject({ ref: await sha256Hex("reply_1"), replyRef: await sha256Hex("root_1") });
      expect(answer.replyRef).toBe(await sha256Hex("root_1"));
      expect(answer.ref).toMatch(/^[0-9a-f]{64}$/);
    });
  });
}
