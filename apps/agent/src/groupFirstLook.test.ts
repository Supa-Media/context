/**
 * THE ONE JUDGE IN A GROUP, AND WHAT IT NEVER READS (Dev2, 2026-11-11, one judge:
 * `docs/decisions/texting-assistant/one-judge-one-record.md`; security review of the same day).
 *
 * - A bound chat: every message that is not a command goes to the judge, whatever the speak-up level, and names the
 *   chat's ledger key so the gateway keeps the verdict there.
 * - A chat Tex is not set up in, or an SMS: fail closed. Nothing is read, not even by the judge, unless it tags or
 *   names Tex or replies under its text; that one is judged on its own words, logged only if answered.
 * - A muted chat: nothing but a command said to Tex by name is read.
 *
 * Sabotage record (2026-11-11), each applied, suite run, named test failing, reverted:
 *  1. the unbound gate without `callsTex` (every message to a first look) → "a chat Tex is not set up in" fails.
 *  2. the unbound gate without `isMuted` → "a muted chat" fails.
 *  3. `ask` without `ledger` → "a bound chat's message goes to the judge" fails.
 *  4. `firstLook` logging a quiet line → "a first look the judge is quiet on" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { sha256Hex } from "./groupChat";
import { MemoryStorage } from "./memoryStorage.testing";
import { ADA, chatLog, fakeJudge, LINE, LINES, setup } from "./groupWorld.testing";

const { groupId } = LINES[0];

async function bound(storage: MemoryStorage, w: ReturnType<typeof setup>): Promise<void> {
  await acceptGroup(storage, w.message("Tex, hi"), 0);
  await drainGroup(storage, w.deps);
}

describe("the one judge in a group", () => {
  it("a bound chat's message goes to the judge at every speak-up level, with the chat's ledger key", async () => {
    for (const engagement of ["quiet", "attentive", "followAlong", "helpful"]) {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: fakeJudge, control: { engagement, engagementChosen: true } });
      await bound(storage, w);
      const before = w.decided.length;
      expect(await acceptGroup(storage, w.message("anyone up for tacos?"), 10)).toBe("kept");
      await drainGroup(storage, w.deps);
      expect(w.decided.length, engagement).toBe(before + 1);
      expect(w.decided.at(-1), engagement).toMatchObject({ style: engagement, ledger: await sha256Hex(`${LINE}:${groupId}`) });
      expect(w.asks.map((ask) => ask.question), engagement).toEqual(["Tex, hi"]);
    }
  });

  it("a chat Tex is not set up in: chatter is never read, not even by the judge; a message calling Tex gets a first look", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, { decide: fakeJudge });
    for (const text of ["anyone up for tacos?", "stop", "Texas was hot", "tex-mex tonight"]) {
      expect(await acceptGroup(storage, w.message(text), 0), text).toBe("ignored");
    }
    expect([...(await storage.list({ prefix: "gpending:" })).keys()]).toEqual([]);
    for (const text of ["@Tex what's 2+2", "can Tex check the weather", "@\u2068Tex\u2069 summarize this", "what time is it tex"]) {
      expect(await acceptGroup(storage, w.message(text), 0), text).toBe("queued");
    }
    await drainGroup(storage, w.deps);
    expect(w.decided).toHaveLength(1);
    // A first look reads only the waiting lines, and keeps its verdict in no ledger.
    expect(w.decided[0]!.ledger).toBeUndefined();
    expect(w.decided[0]!.transcript).toContain("@Tex what's 2+2");
    expect(w.decided[0]!.transcript).not.toContain("tacos");
  });

  it("a first look the judge is quiet on is dropped, logged nowhere and kept as no chat line", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, { decide: () => ({ ok: true, act: "silent", covers: [], stale: [], movedOn: false, confidence: 0.9 }) });
    expect(await acceptGroup(storage, w.message("tex was so slow yesterday"), 0)).toBe("queued");
    await drainGroup(storage, w.deps);
    expect(w.asks).toEqual([]);
    expect(await chatLog(storage, w, groupId)).toEqual([]);
    expect([...(await storage.list({ prefix: "gchat:" })).keys()]).toEqual([]);
    expect([...(await storage.list({ prefix: "gpending:" })).keys()]).toEqual([]);
  });

  it("a first look the judge answers is logged, then answered", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, { decide: fakeJudge });
    await acceptGroup(storage, w.message("Tex find us a dinner spot"), 0);
    await drainGroup(storage, w.deps);
    expect(w.asks.map((ask) => ask.question)).toEqual(["Tex find us a dinner spot"]);
    expect((await chatLog(storage, w, groupId)).map((event) => event.text)).toContain("Tex find us a dinner spot");
  });

  it("an SMS that does not call Tex is never read", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, { decide: fakeJudge });
    await bound(storage, w);
    const before = w.decided.length;
    expect(await acceptGroup(storage, w.message("anyone up for tacos?", { sms: true }), 10)).toBe("ignored");
    await drainGroup(storage, w.deps);
    expect(w.decided.length).toBe(before);
  });

  it("a muted chat reads nothing but a command said to Tex by name, not even a message naming Tex", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, { decide: fakeJudge, controlFor: (body) => (body.command ? { status: "stopped" } : undefined) });
    await bound(storage, w);
    await acceptGroup(storage, w.message("Tex, stop"), 10);
    await drainGroup(storage, w.deps);
    const decided = w.decided.length;
    for (const text of ["Tex what's 2+2", "@Tex are you there", "anyone up for tacos?"]) {
      expect(await acceptGroup(storage, w.message(text), 20), text).toBe("ignored");
    }
    await drainGroup(storage, w.deps);
    expect(w.decided.length).toBe(decided);
    expect(await acceptGroup(storage, w.message("Tex, start", { from: ADA }), 30)).toBe("queued");
  });
});
