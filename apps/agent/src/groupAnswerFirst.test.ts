/**
 * A group turn is answered in the chat's object at once, and its workflow only retries one that failed (Dev2,
 * 2026-10-31: starting a workflow cost 1 to 2 s of every group reply; `groupTurnRun.ts` `answerFirst`).
 *
 * Sabotage (temporary local edits, reverted):
 *  - `handOff` ignoring `deps.answerFirst` → "a turn is answered at once, no workflow started" fails;
 *  - `answerFirst` never starting the workflow after a failure → "a failed first answer goes to its workflow" fails;
 *  - `handedTurnWaits` treating an inline turn as running whatever `answering` says → "a turn lost mid-answer" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { LINES, setup } from "./groupWorld.testing";
import { answerHanded, failHanded, TURN_KEY, type HandedTurn } from "./groupTurnRun";
import { runGroupTurn, type InboxCall } from "./groupTurnWorkflow";
import type { Fetch } from "./clients";

/** A chat whose turns are answered first and handed to a workflow only on failure; `kept` is what `answerFirst` holds. */
function firstWorld(groupId: string, opts: Parameters<typeof setup>[1] = {}) {
  const storage = new MemoryStorage();
  const w = setup(groupId, opts);
  const started: string[] = [];
  const kept: Promise<unknown>[] = [];
  const deps = { ...w.deps, startTurn: async (turn: string) => void started.push(turn), answerFirst: (work: Promise<unknown>) => void kept.push(work) };
  const settle = async () => {
    while (kept.length > 0) await kept.shift();
  };
  return { storage, w, deps, started, settle };
}

const { name, groupId } = LINES[0];

describe(`a group turn answered first, ${name}`, () => {
  it("a turn is answered at once, no workflow started", async () => {
    const { storage, w, deps, started, settle } = firstWorld(groupId);
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    await drainGroup(storage, deps);
    await settle();
    expect(started).toEqual([]);
    expect(w.texts).toContain("answer to Tex what's on tonight");
    expect(await storage.get(TURN_KEY)).toBeUndefined();
    expect([...(await storage.list({ prefix: "gpending:" })).keys()]).toEqual([]);
  });

  it("while it is being answered, the chat is held: the next message waits for it", async () => {
    const { storage, w, deps, settle } = firstWorld(groupId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    deps.fetch = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/agent") {
        asked += 1;
        await gate;
      }
      return await w.deps.fetch(url, init);
    }) as unknown as Fetch;
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    await drainGroup(storage, deps);
    for (let tick = 0; tick < 100 && asked === 0; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    await acceptGroup(storage, w.message("Tex and tomorrow?", { from: "+15555550102" }), 10);
    await drainGroup(storage, deps);
    expect(asked).toBe(1);
    release();
    await settle();
    await drainGroup(storage, deps);
    await settle();
    expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what's on tonight", "Tex and tomorrow?"]);
  });

  it("a failed first answer goes to its workflow, which answers it", async () => {
    const { storage, w, deps, started, settle } = firstWorld(groupId);
    let tries = 0;
    deps.fetch = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/agent" && ++tries === 1) return new Response("down", { status: 502 });
      return await w.deps.fetch(url, init);
    }) as unknown as Fetch;
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    await drainGroup(storage, deps);
    await settle();
    expect(started).toHaveLength(1);
    expect((await storage.get<HandedTurn>(TURN_KEY))?.started).toBe(true);
    const inbox: InboxCall = async (path, turn) => Response.json({ outcome: await (path === "/group-answer" ? answerHanded : failHanded)(storage, deps, turn) });
    const step = { do: async <T>(_name: string, ...rest: unknown[]) => await (rest.at(-1) as () => Promise<T>)() } as unknown as Parameters<typeof runGroupTurn>[1];
    expect(await runGroupTurn({ inbox: "inbox", turn: started[0] }, step, inbox)).toBe("done");
    expect(w.texts).toContain("answer to Tex what's on tonight");
    expect(await storage.get(TURN_KEY)).toBeUndefined();
  });

  it("a turn lost mid-answer (the object restarted) is handed to its workflow at the next drain", async () => {
    const { storage, w, deps, started } = firstWorld(groupId);
    await storage.put<HandedTurn>(TURN_KEY, { id: "lost-turn-1", keys: [], at: 0, starts: 0, inline: true });
    await drainGroup(storage, deps);
    expect(started).toEqual(["lost-turn-1"]);
    expect((await storage.get<HandedTurn>(TURN_KEY))?.inline).toBeUndefined();
    expect(w.asks).toHaveLength(0);
  });
});
