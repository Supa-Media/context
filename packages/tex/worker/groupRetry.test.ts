/**
 * A group turn that failed is tried again by its chat's own alarm (`groupRetry.ts`, Dev2, 2026-11-21), as the
 * `group-turn` workflow did before: at once, then 10, 20 and 40 s apart, and after the last the chat is told.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `retryDue` returning before it answers → "a failed first answer is answered again by the alarm" fails;
 *  - `retryDue` never giving up (no `RETRY_LIMIT` check) → "a turn that keeps failing ... tells the chat" fails;
 *  - no watch armed before a try → "a try lost to a restart is tried again from its watch" fails.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { AlarmStorage } from "./memoryStorage.testing";
import { LINES, setup } from "./groupWorld.testing";
import { handedTurns, turnKey, type HandedTurn } from "./groupTurnRun";
import { retryKey, retryLater, TRY_WATCH_MS, type Retry } from "./groupRetry";
import { GROUP_LINES } from "./groupLines";
import type { Fetch } from "./clients";

/** A chat as its object runs it: answered beside the drain, a failed turn retried by its own alarm. */
function retryWorld(groupId: string) {
  const storage = new AlarmStorage();
  const w = setup(groupId);
  const clock = { now: 1_000 };
  const kept: Promise<unknown>[] = [];
  const deps = {
    ...w.deps,
    now: () => clock.now,
    startTurn: (turn: string) => retryLater(storage, turn, clock.now),
    answerFirst: (work: Promise<unknown>) => void kept.push(work),
  };
  const settle = async () => {
    while (kept.length > 0) await kept.shift();
  };
  /** The alarm firing when it was set for, and the drain it runs, until nothing is set or `max` fired. */
  const alarms = async (max = 20) => {
    const fired: number[] = [];
    for (let i = 0; i < max && storage.alarm !== null; i += 1) {
      clock.now = Math.max(clock.now, storage.alarm);
      fired.push(clock.now);
      storage.fire();
      await drainGroup(storage, deps);
      await settle();
    }
    return fired;
  };
  return { storage, w, deps, clock, settle, alarms };
}

/** `/agent` failing `n` times, then answering as the world does; counts every ask. */
function failing(w: ReturnType<typeof setup>, n: number) {
  const asked = { count: 0 };
  const fetch = (async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === "/agent" && ++asked.count <= n) return new Response("down", { status: 502 });
    return await w.deps.fetch(url, init);
  }) as unknown as Fetch;
  return { fetch, asked };
}

const { name, groupId } = LINES[0];

afterEach(() => vi.restoreAllMocks());

describe(`a group turn retried by its chat's alarm, ${name}`, () => {
  it("a failed first answer is answered again by the alarm, at once, and nothing is left behind", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { storage, w, deps, settle, alarms } = retryWorld(groupId);
    const { fetch, asked } = failing(w, 1);
    deps.fetch = fetch;
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    await drainGroup(storage, deps);
    await settle();
    const [turn] = await handedTurns(storage);
    expect(turn?.started).toBe(true);
    expect(await storage.get<Retry>(retryKey(turn!.id))).toEqual({ tries: 0, dueAt: 1_000 });
    await alarms();
    expect(asked.count).toBe(2);
    expect(w.texts).toContain("answer to Tex what's on tonight");
    expect(await handedTurns(storage)).toEqual([]);
    expect([...(await storage.list({ prefix: "gretry:" })).keys()]).toEqual([]);
  });

  it("a turn that keeps failing is tried four more times, 10, 20 and 40 s apart, then tells the chat", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const { storage, w, deps, settle, alarms } = retryWorld(groupId);
    const { fetch, asked } = failing(w, 99);
    deps.fetch = fetch;
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    await drainGroup(storage, deps);
    await settle();
    const fired = await alarms();
    // The first answer, then the four tries the workflow's step had.
    expect(asked.count).toBe(5);
    const tries = logs.mock.calls.flat().map((line) => JSON.parse(String(line))).filter((line) => line.event === "group_turn" && line.outcome === "retry_started");
    expect(tries.map((line) => line.attempts)).toEqual([1, 2, 3, 4]);
    const at = fired.slice(0, 5);
    expect(at.slice(1).map((time, i) => time - at[i])).toEqual([10_000, 20_000, 40_000, 0]);
    expect(w.texts).toContain(GROUP_LINES.failed);
    expect(w.texts).not.toContain("answer to Tex what's on tonight");
    expect(await handedTurns(storage)).toEqual([]);
    expect([...(await storage.list({ prefix: "gretry:" })).keys()]).toEqual([]);
  });

  it("a try lost to a restart is tried again from its watch", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { storage, w, deps, clock, alarms } = retryWorld(groupId);
    // A failed turn whose retry was running when its object restarted: due again only at its watch.
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    const keys = [...(await storage.list({ prefix: "gpending:" })).keys()];
    await storage.put<HandedTurn>(turnKey("t-lost"), { id: "t-lost", keys, at: clock.now, starts: 0, started: true, asker: w.message("x").from });
    await storage.put<Retry>(retryKey("t-lost"), { tries: 1, dueAt: clock.now + TRY_WATCH_MS });
    storage.fire();
    await drainGroup(storage, deps);
    expect(w.asks).toHaveLength(0);
    expect(storage.alarm).toBe(clock.now + TRY_WATCH_MS);
    await alarms();
    expect(w.texts).toContain("answer to Tex what's on tonight");
    expect(await handedTurns(storage)).toEqual([]);
  });

  it("a try that hangs is due again at its watch, and after a restart that watch answers it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { storage, w, deps, clock, settle } = retryWorld(groupId);
    let asked = 0;
    deps.fetch = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/agent") {
        asked += 1;
        if (asked === 1) return new Response("down", { status: 502 });
        if (asked === 2) return await new Promise<Response>(() => {}); // the try whose isolate is about to go
      }
      return await w.deps.fetch(url, init);
    }) as unknown as Fetch;
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    await drainGroup(storage, deps);
    await settle();
    storage.fire();
    await drainGroup(storage, deps);
    for (let tick = 0; tick < 100 && asked < 2; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(asked).toBe(2);
    const [turn] = await handedTurns(storage);
    expect(await storage.get<Retry>(retryKey(turn!.id))).toEqual({ tries: 1, dueAt: clock.now + TRY_WATCH_MS });
    expect(storage.alarm).toBe(clock.now + TRY_WATCH_MS);
    // The object restarts: the same storage, nothing in memory. Its watch fires and the turn is answered.
    const after = new AlarmStorage();
    after.data = new Map(storage.data);
    after.alarm = storage.alarm;
    const kept: Promise<unknown>[] = [];
    const again = { ...deps, startTurn: (id: string) => retryLater(after, id, clock.now), answerFirst: (work: Promise<unknown>) => void kept.push(work) };
    clock.now = after.alarm!;
    after.fire();
    await drainGroup(after, again);
    while (kept.length > 0) await kept.shift();
    expect(asked).toBe(3);
    expect(w.texts).toContain("answer to Tex what's on tonight");
    expect(await handedTurns(after)).toEqual([]);
  });

  it("a turn its workflow started before 2026-11-21 (no retry kept) is left to that workflow", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { storage, w, deps, clock } = retryWorld(groupId);
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    const keys = [...(await storage.list({ prefix: "gpending:" })).keys()];
    await storage.put<HandedTurn>(turnKey("t-flow"), { id: "t-flow", keys, at: clock.now, starts: 0, started: true, asker: w.message("x").from });
    storage.fire();
    await drainGroup(storage, deps);
    expect(w.asks).toHaveLength(0);
    expect((await handedTurns(storage)).map((turn) => turn.id)).toEqual(["t-flow"]);
  });
});
