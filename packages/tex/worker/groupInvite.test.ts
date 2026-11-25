/**
 * "Share @studio with everyone here", in any words (Dev2, 2026-11-12): the turn's tool asks for it
 * (`packages/tex/gateway/agent/settingsTools.js` `chat_add_everyone`), and this Worker runs the invitation as its asker once the
 * answer has gone (`groupInvite.ts`).
 *
 * Sabotage (temporary local edits, reverted): `groupModelTurn.ts` never calling `inviteEveryone` fails the first test;
 * `readInvite` taking any slug fails the second; `inviteEveryone` not calling `dropKept` fails the third.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup, GROUP_LINES } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { TEX_CONFIG } from "../../../packages/tex/src/texConfig.cjs";
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

  it("drops the kept token, so the next tag mints one that reaches the workspace", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, {
      controlFor: (body) => (isInvite(body) ? { status: "invited", slug: "studio", count: 1, role: "member" } : undefined),
      agent: (body) => (String(body.question).includes("share") ? { answer: "Adding everyone.", invite: { slug: "studio", role: "member" } } : { answer: "Here it is." }),
    });
    await acceptGroup(storage, w.message("Tex share @studio with everyone here"), 0);
    await drainGroup(storage, w.deps);
    const before = w.control.length;
    await acceptGroup(storage, w.message("Tex what are the priorities"), 0);
    await drainGroup(storage, w.deps);
    expect(w.control.slice(before).filter((body) => !isInvite(body))[0]).toEqual(expect.objectContaining({ mint: true }));
  });
});

/** Main's config with node `did` wired in, as a Lab draft would have it. */
const withDid = { ...TEX_CONFIG, nodes: [...(TEX_CONFIG as { nodes: unknown[] }).nodes, { id: "did", on: true }] };
const isDid = (body: Record<string, unknown>) => body.event === "did";

describe("with node did wired, Tex says how the invite went, from the facts (Dev2, 2026-11-25)", () => {
  it("queues a turn of the chat's own with the facts, and sends what Tex wrote, never the fixed line", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, {
      controlFor: (body) => (isInvite(body) ? { status: "invited", slug: "studio", count: 1, role: "member" } : undefined),
      agent: (body) => (isDid(body) ? { answer: "Bo's in @studio now." } : { answer: "Adding everyone here to @studio.", invite: { slug: "studio", role: "member" } }),
    });
    w.deps.texGraph = withDid;
    await acceptGroup(storage, w.message("Tex can you share @studio with everyone here, read only"), 0);
    await drainGroup(storage, w.deps);
    expect(w.texts).toEqual(["Adding everyone here to @studio.", "Bo's in @studio now."]);
    const told = w.asks.filter(isDid);
    expect(told).toHaveLength(1);
    expect(told[0]!.did).toEqual({ action: "invite", status: "invited", workspace: "@studio", people: 1, role: "member" });
    expect(w.control.filter(isInvite)).toHaveLength(1); // the action ran once, before the turn that says it
  });

  it("a refusal is told the same way", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, {
      controlFor: (body) => (isInvite(body) ? { status: "not_allowed", slug: "studio" } : undefined),
      agent: (body) => (isDid(body) ? { answer: "Only an owner of @studio can do that one." } : { answer: "On it.", invite: { slug: "studio" } }),
    });
    w.deps.texGraph = withDid;
    await acceptGroup(storage, w.message("Tex share @studio with everyone", { from: BO }), 0);
    await drainGroup(storage, w.deps);
    expect(w.asks.filter(isDid)[0]!.did).toEqual({ action: "invite", status: "not_owner", workspace: "@studio" });
    expect(w.texts).toEqual(["On it.", "Only an owner of @studio can do that one."]);
  });

  it("with the model out, the invite still stands and the old line goes once, never silence", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, {
      controlFor: (body) => (isInvite(body) ? { status: "invited", slug: "studio", count: 1, role: "member" } : undefined),
      agent: (body) => (isDid(body) ? new Response(JSON.stringify({ error: "no_provider" }), { status: 409 }) : { answer: "Adding everyone here to @studio.", invite: { slug: "studio", role: "member" } }),
    });
    w.deps.texGraph = withDid;
    await acceptGroup(storage, w.message("Tex share @studio with everyone here"), 0);
    await drainGroup(storage, w.deps);
    expect(w.control.filter(isInvite)).toHaveLength(1);
    expect(w.texts.filter((text) => text === GROUP_LINES.invited("studio", 1, "member"))).toHaveLength(1);
  });

  it("the gateway unavailable on every try (an overloaded model), the old line goes once after the retries, and the invite ran once", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, {
      controlFor: (body) => (isInvite(body) ? { status: "invited", slug: "studio", count: 2, role: "editor" } : undefined),
      agent: (body) => (isDid(body) ? new Response("{}", { status: 503 }) : { answer: "Adding everyone.", invite: { slug: "studio", role: "editor" } }),
    });
    w.deps.texGraph = withDid;
    await acceptGroup(storage, w.message("Tex can you share @studio with everyone here as editors"), 0);
    for (let round = 0; round < 6; round++) await drainGroup(storage, { ...w.deps, now: () => 1_000 + round * 60_000 });
    expect(w.control.filter(isInvite)).toHaveLength(1);
    expect(w.texts.filter((text) => text === GROUP_LINES.invited("studio", 2, "editor"))).toHaveLength(1);
    expect(w.asks.filter(isDid).length).toBeGreaterThan(1); // tried again, not dropped at the first refusal
  });
});
