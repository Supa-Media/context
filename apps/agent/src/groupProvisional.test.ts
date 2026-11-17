/**
 * A group's Provisional run (`provisional.ts`, `groupTurnRun.ts` `startEarly`; Dev2, 2026-11-17): wired in the config,
 * a burst's turn starts beside Decide, and Decide's choice is its go or its stop.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `drainOnce` not calling `startEarly` → "the turn is asked before Decide answers" fails;
 *  - `settleEarly` told "go" for a quiet choice → "Decide says quiet: the run is stopped, nothing is said" fails;
 *  - `groupTurn` not sending `provisional` → "told go, it answers as any turn" fails;
 *  - `startEarly` handing the run to answerFirst without its gate → "answered first: stopped" fails;
 *  - `liveTurns` handing a lost provisional run to its workflow → "a provisional run lost to a restart is nobody's turn" fails.
 */

import { describe, expect, it } from "vitest";
import config from "../../../packages/shared/src/texConfig.json" with { type: "json" };
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { BO, LINES, setup, silent, answerAll } from "./groupWorld.testing";
import { handedTurns, liveTurns, turnKey, type HandedTurn } from "./groupTurnRun";
import { provisionalDoor, sameMessages } from "./provisional";
import type { Fetch } from "./clients";

/** The built-in config with Triage, Decide and the Queue wired to the Door step as a Provisional run. */
const wired = {
  ...config,
  edges: [
    ...config.edges.filter((edge) => !(edge.from === "lanes" && edge.to === "doorStep")),
    { from: "triage", to: "doorStep", mode: "provisional", when: ["stop:running"] },
    { from: "decide", to: "doorStep", mode: "provisional", when: ["stop:quiet", "restart:wait"] },
    { from: "lanes", to: "doorStep", mode: "provisional", when: ["*"] },
  ],
};

/**
 * A world whose gateway holds a provisional turn's answer until the Worker's go or stop, as `apps/mcp` does
 * (`steer.js`, `runTheModel.js`); `tool` makes the turn start a tool (a tapback) while it waits.
 */
function provisionalWorld(groupId: string, opts: Parameters<typeof setup>[1] & { tool?: boolean } = {}) {
  const storage = new MemoryStorage();
  const w = setup(groupId, opts);
  const verdicts = new Map<string, (verdict: "go" | "stop") => void>();
  const told: { path: string; body: Record<string, unknown> }[] = [];
  const asked: Record<string, unknown>[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (path === "/agent/go" || (path === "/agent/cancel" && body.provisional === true)) {
      told.push({ path, body });
      verdicts.get(String(body.turn))?.(path === "/agent/go" ? "go" : "stop");
      return path === "/agent/go" ? Response.json({ go: verdicts.has(String(body.turn)) }) : Response.json({ cancelled: true });
    }
    if (path === "/agent" && body.provisional === true) {
      asked.push(body);
      const verdict = await new Promise<"go" | "stop">((resolve) => verdicts.set(String(body.turn), resolve));
      if (verdict === "stop") return Response.json({ cancelled: true, answer: "" });
    }
    return await w.deps.fetch(url, init);
  }) as unknown as Fetch;
  const deps = { ...w.deps, fetch: fetcher, texGraph: wired };
  return { storage, w, deps, told, asked };
}

const { name, groupId } = LINES[0];

describe(`a group's Provisional run, ${name}`, () => {
  it("reads the wiring from the config: off as built, on when wired, read only when any wire says so", () => {
    expect(provisionalDoor(config)).toEqual({ on: false, allow: "read" });
    expect(provisionalDoor(wired)).toEqual({ on: true, allow: "revertible" });
    const narrowed = { ...wired, edges: wired.edges.map((edge) => (edge.from === "decide" && edge.mode === "provisional" ? { ...edge, allow: "read" } : edge)) };
    expect(provisionalDoor(narrowed)).toEqual({ on: true, allow: "read" });
    expect(sameMessages(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameMessages(["a"], ["a", "b"])).toBe(false);
  });

  it("not wired, a turn is asked as before: after Decide, never provisionally", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId, { decide: answerAll });
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    await drainGroup(storage, w.deps);
    expect(w.asks).toHaveLength(1);
    expect(w.asks[0].provisional).toBeUndefined();
    expect(w.texts).toContain("answer to Tex what's on tonight");
  });

  it("told go, it answers as any turn", async () => {
    const { storage, w, deps, told, asked } = provisionalWorld(groupId, { decide: answerAll });
    await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
    await drainGroup(storage, deps);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ provisional: true, allow: "revertible" });
    // Tried until the gateway has the turn running, then once more never.
    expect(new Set(told.map((one) => one.path))).toEqual(new Set(["/agent/go"]));
    expect(told.at(-1)!.body.turn).toBe(asked[0].turn);
    expect(w.texts).toContain("answer to Tex what's on tonight");
    expect([...(await storage.list({ prefix: "gpending:" })).keys()]).toEqual([]);
  });

  it("the turn is asked before Decide answers", async () => {
    let decideNow!: () => void;
    const slow = new Promise<void>((resolve) => (decideNow = resolve));
    const { storage, w, deps, asked } = provisionalWorld(groupId, { decide: silent, decideWait: () => slow });
    await acceptGroup(storage, w.message("anyone up for pizza tex", { from: BO }), 0);
    const draining = drainGroup(storage, deps);
    for (let tick = 0; tick < 200 && asked.length === 0; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(asked).toHaveLength(1);
    expect(w.decided.length).toBeGreaterThan(0);
    decideNow();
    await draining;
  });

  it("Decide says quiet: the run is stopped, nothing is said, and the message stays the chat's", async () => {
    // Decide answers once the turn is with the gateway, so the stop lands mid-turn.
    let asking!: () => void;
    const reached = new Promise<void>((resolve) => (asking = resolve));
    const { storage, w, deps, told, asked } = provisionalWorld(groupId, { decide: silent, decideWait: () => reached });
    const watching = setInterval(() => asked.length > 0 && asking(), 1);
    await acceptGroup(storage, w.message("lol nice tex", { from: BO }), 0);
    await drainGroup(storage, deps);
    clearInterval(watching);
    expect(asked).toHaveLength(1);
    expect(told.map((one) => one.path)).toEqual(["/agent/cancel"]);
    expect(told[0].body).toMatchObject({ provisional: true, turn: asked[0].turn });
    expect(w.texts).toEqual([]);
    expect(w.reactions).toEqual([]);
    expect([...(await storage.list({ prefix: "gpending:" })).keys()]).toEqual([]);
    expect(await handedTurns(storage)).toEqual([]);
  });

  it("stopped before it reached the gateway, it never asks", async () => {
    const { storage, w, deps, asked } = provisionalWorld(groupId, { decide: silent });
    await acceptGroup(storage, w.message("lol nice tex", { from: BO }), 0);
    await drainGroup(storage, deps);
    expect(asked.length).toBeLessThanOrEqual(1);
    expect(w.texts).toEqual([]);
  });

  it("nothing reaches the chat while the verdict is out, and a stop drops it", async () => {
    let decideNow!: () => void;
    const slow = new Promise<void>((resolve) => (decideNow = resolve));
    const { storage, w, deps, asked } = provisionalWorld(groupId, { decide: silent, decideWait: () => slow });
    await acceptGroup(storage, w.message("anyone up for pizza tex", { from: BO }), 0);
    const draining = drainGroup(storage, deps);
    for (let tick = 0; tick < 200 && asked.length === 0; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(w.reactions).toEqual([]);
    expect(w.texts).toEqual([]);
    decideNow();
    await draining;
    expect(w.reactions).toEqual([]);
    expect(w.texts).toEqual([]);
  });

  it("answered first (with a workflow): told go it answers, stopped it is nobody's turn", async () => {
    for (const [decide, text] of [[answerAll, "Tex what's on tonight"], [silent, "lol nice tex"]] as const) {
      const { storage, w, deps, told } = provisionalWorld(groupId, { decide });
      const kept: Promise<unknown>[] = [];
      const started: string[] = [];
      const first = { ...deps, startTurn: async (id: string) => void started.push(id), answerFirst: (work: Promise<unknown>) => void kept.push(work) };
      await acceptGroup(storage, w.message(text, { from: BO }), 0);
      await drainGroup(storage, first);
      while (kept.length > 0) await kept.shift();
      expect(started).toEqual([]);
      expect(await handedTurns(storage)).toEqual([]);
      if (decide === answerAll) {
        expect(w.texts).toContain(`answer to ${text}`);
        expect(told.some((one) => one.path === "/agent/go")).toBe(true);
      } else {
        expect(w.texts).toEqual([]);
        expect(told.some((one) => one.path === "/agent/go")).toBe(false);
      }
      expect([...(await storage.list({ prefix: "gpending:" })).keys()]).toEqual([]);
    }
  });

  it("a provisional run lost to a restart is nobody's turn: its record goes, and its messages wait for the drain", async () => {
    const storage = new MemoryStorage();
    const w = setup(groupId);
    const turn: HandedTurn = { id: "lost-1", keys: ["gpending:1"], at: 0, starts: 0, inline: true, provisional: true, asker: BO };
    await storage.put(turnKey(turn.id), turn);
    const started: string[] = [];
    const left = await liveTurns(storage, { ...w.deps, startTurn: async (id: string) => void started.push(id), answerFirst: () => {} });
    expect(left).toEqual([]);
    expect(started).toEqual([]);
  });
});
