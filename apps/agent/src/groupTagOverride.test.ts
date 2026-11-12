/**
 * A literal "@Tex" tag is always answered (Dev2, 2026-11-12). In production "@Tex what's 18% of 250?" was judged
 * silent, a slow tapback came 25 s later, and the answer only after a later message. The judge still decides
 * everything else: the bare name, and any message with no tag.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `taggedIndex` returning -1 always: "the judge says silent on @Tex", "react on @Tex" and "a first look the
 *     judge is silent on" fail.
 *  2. `tagsTex` matching the bare name (`@?tex`): "tagsTex reads @Tex" and "the bare name judged silent" fail.
 *  3. `acceptGroup` without its `isMuted` check: "a muted chat is unchanged" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { answerAll, LINES, setup, silent, type Answer, type Decide } from "./groupWorld.testing";
import { tagsTex } from "./groupWords";

const { groupId } = LINES[0];
const react = (): Answer => ({ ok: true, act: "react", covers: [], stale: [], movedOn: false, confidence: 0.9, emoji: "👍" });

/** A bound chat: Tex answered a first tag, then the judge is replaced by `judge`. */
async function boundWith(judge: (body: Decide) => Answer) {
  const storage = new MemoryStorage();
  let current: (body: Decide) => Answer = answerAll;
  const w = setup(groupId, { decide: (body) => current(body) });
  await acceptGroup(storage, w.message("Tex, hi"), 0);
  await drainGroup(storage, w.deps);
  current = judge;
  return { storage, w, before: w.asks.length };
}

describe("a literal @Tex tag is answered whatever the judge says", () => {
  it("tagsTex reads @Tex as a word in any case, never the bare name", () => {
    expect(tagsTex("@Tex what's 18% of 250?")).toBe(true);
    expect(tagsTex("hey @\u2068tex\u2069 you there")).toBe(true);
    expect(tagsTex("Tex what's 18% of 250?")).toBe(false);
    expect(tagsTex("@Texas trip")).toBe(false);
    expect(tagsTex("mail me@tex.example")).toBe(false);
  });

  it("the judge says silent on @Tex what's 18% of 250?: Tex answers it", async () => {
    const { storage, w, before } = await boundWith(silent);
    await acceptGroup(storage, w.message("@Tex what's 18% of 250?"), 10);
    await drainGroup(storage, w.deps);
    expect(w.asks.slice(before).map((ask) => ask.question)).toEqual(["@Tex what's 18% of 250?"]);
  });

  it("the judge says react on @Tex: Tex answers, with no tapback beside it", async () => {
    const { storage, w, before } = await boundWith(react);
    const reactions = w.reactions.length;
    await acceptGroup(storage, w.message("@Tex what's 18% of 250?"), 10);
    await drainGroup(storage, w.deps);
    expect(w.asks.slice(before).map((ask) => ask.question)).toEqual(["@Tex what's 18% of 250?"]);
    expect(w.reactions.length).toBe(reactions);
  });

  it("the bare name, or no tag, judged silent stays silent", async () => {
    const { storage, w, before } = await boundWith(silent);
    await acceptGroup(storage, w.message("Tex was slow yesterday"), 10);
    await acceptGroup(storage, w.message("what's 18% of 250?"), 11);
    await drainGroup(storage, w.deps);
    expect(w.asks.length).toBe(before);
  });

  it("a first look the judge is silent on is answered when it tags @Tex", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, { decide: silent });
    await acceptGroup(storage, w.message("@Tex what's 18% of 250?"), 0);
    await drainGroup(storage, w.deps);
    expect(w.asks.map((ask) => ask.question)).toEqual(["@Tex what's 18% of 250?"]);
  });

  it("a muted chat is unchanged: an @Tex that is not a command is never read", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, { decide: answerAll, control: { status: "muted" } });
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    await drainGroup(storage, w.deps);
    const decided = w.decided.length;
    expect(await acceptGroup(storage, w.message("@Tex what's 18% of 250?"), 10)).toBe("ignored");
    await drainGroup(storage, w.deps);
    expect(w.asks).toEqual([]);
    expect(w.decided.length).toBe(decided);
  });
});
