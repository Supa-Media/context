/**
 * A muted group chat is never silent about being muted (Dev2, 2026-11-20). In Nov Babies a check-in turn called
 * `chat_mute` on "Tex stop talking, now and forever", the reviewer sent its "text Tex, start" line back, and a week later
 * "Tex can you email..." was dropped with no word. So:
 * - a turn that mutes the chat says so in code, in the fixed words "Tex, stop" gets, whatever the turn texted;
 * - a clear ask in a muted chat hears, once a mute, how to start Tex again, and nothing of it runs.
 *
 * Sabotage record (2026-11-20), each applied, suite run, named test failing, reverted:
 *  1. `groupModelTurn` without its `answer.muted` branch → "a turn that mutes the chat" fails.
 *  2. `answerGroup` without its muted-told line → "a clear ask in a muted chat" fails.
 *  3. `acceptGroup` reading a muted chat's naming line every time (no `mutedTold`) → "only once a mute" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { GROUP_LINES } from "./groupLines";
import { MemoryStorage } from "./memoryStorage.testing";
import { fakeJudge, LINES, setup } from "./groupWorld.testing";

const { groupId } = LINES[0];

describe("a muted group chat is never silent about it", () => {
  it("a turn that mutes the chat says so in fixed words, never the turn's own, and the chat then reads nothing", async () => {
    const storage = new MemoryStorage();
    let muted = false;
    const w = setup(groupId, {
      decide: fakeJudge,
      controlFor: (body) => (muted && !body.command ? { status: "muted" } : undefined),
      agent: () => ((muted = true), { answer: "", quiet: true, muted: true }),
    });
    await acceptGroup(storage, w.message("Tex stop talking, now and forever"), 0);
    await drainGroup(storage, w.deps);
    expect(w.texts).toEqual([GROUP_LINES.stopped]);
    expect(await acceptGroup(storage, w.message("anyone up for tacos?"), 10)).toBe("ignored");
  });

  it("a clear ask in a muted chat hears how to start Tex again, only once a mute, and Tex, start resets it", async () => {
    const storage = new MemoryStorage();
    let muted = true;
    const w = setup(groupId, {
      decide: fakeJudge,
      controlFor: (body) => (body.command ? ((muted = false), { status: "started" }) : muted ? { status: "muted" } : undefined),
    });
    // Muted by the control plane, as Nov Babies was: the chat's first ask is judged, then hears the way back.
    expect(await acceptGroup(storage, w.message("Tex can you email puttery about a cake"), 0)).toBe("queued");
    await drainGroup(storage, w.deps);
    expect(w.texts).toEqual([GROUP_LINES.muted]);
    expect(w.asks).toEqual([]);
    // Only once a mute: the next is never read.
    expect(await acceptGroup(storage, w.message("TEX"), 10)).toBe("ignored");
    await drainGroup(storage, w.deps);
    expect(w.texts).toEqual([GROUP_LINES.muted]);
    // Started again, then muted again: told again.
    await acceptGroup(storage, w.message("Tex, start"), 20);
    await drainGroup(storage, w.deps);
    expect(w.texts.at(-1)).toBe(GROUP_LINES.started);
    muted = true;
    await acceptGroup(storage, w.message("Tex what's on tonight"), 30);
    await drainGroup(storage, w.deps);
    expect(w.texts.at(-1)).toBe(GROUP_LINES.muted);
    expect(w.asks).toEqual([]);
  });
});
