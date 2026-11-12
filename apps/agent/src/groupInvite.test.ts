/**
 * "Share @studio with everyone here", in any words (Dev2, 2026-11-12): the turn's tool asks for it
 * (`apps/mcp/src/agent/settingsTools.js` `chat_add_everyone`), and this Worker runs the invitation as its asker once the
 * answer has gone (`groupInvite.ts`).
 *
 * Sabotage (temporary local edits, reverted): `groupModelTurn.ts` never calling `inviteEveryone` fails the first test;
 * `readInvite` taking any slug fails the second.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup, GROUP_LINES } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { ADA, BO, LINES, setup } from "./groupWorld.testing";

const { groupId } = LINES[0];
const isInvite = (body: Record<string, unknown>) => (body.command as { kind?: string } | undefined)?.kind === "invite";

describe("a workspace shared with everyone here, in any words", () => {
  it("goes as its asker after the answer, and its line follows", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, {
      controlFor: (body) => (isInvite(body) ? { status: "invited", slug: "studio", count: 1, role: "member" } : undefined),
      agent: () => ({ answer: "Adding everyone here to @studio.", invite: { slug: "studio", role: "member" } }),
    });
    await acceptGroup(storage, w.message("Tex can you share @studio with everyone here, read only"), 0);
    await drainGroup(storage, w.deps);
    expect(w.texts).toEqual(["Adding everyone here to @studio.", GROUP_LINES.invited("studio", 1, "member")]);
    expect(w.control.filter(isInvite)).toEqual([expect.objectContaining({ sender: ADA, command: { kind: "invite", slug: "studio", role: "member" } })]);
  });

  it("one the asker can't make is said, and a bad one is never sent", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, {
      controlFor: (body) => (isInvite(body) ? { status: "not_allowed", slug: "studio" } : undefined),
      agent: (body) => (String(body.question).includes("@studio") ? { answer: "On it.", invite: { slug: "studio" } } : { answer: "Hm.", invite: { slug: "../evil" } }),
    });
    await acceptGroup(storage, w.message("Tex share @studio with everyone", { from: BO }), 0);
    await drainGroup(storage, w.deps);
    expect(w.texts).toEqual(["On it.", GROUP_LINES.notOwner("studio")]);
    await acceptGroup(storage, w.message("Tex share it"), 0);
    await drainGroup(storage, w.deps);
    expect(w.texts.at(-1)).toBe("Hm.");
    expect(w.control.filter(isInvite)).toHaveLength(1);
  });
});
