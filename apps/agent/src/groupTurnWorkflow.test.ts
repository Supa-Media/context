/**
 * A group turn handed to its workflow (`groupTurnRun.ts`, `groupTurnWorkflow.ts`;
 * Dev2, 2026-10-27).
 *
 * Workflows itself is not run here: `step` is a stand-in that runs each step
 * inline, as many times as its `retries.limit` allows plus one, and the
 * workflow reaches the chat's object by calling its routes' functions.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `once` in `groupSay.ts` always sending → "a retry sends only what did not
 *    reach the chat" fails;
 *  - `answerHanded` without its `answering` map → "the same turn asked twice
 *    at once is answered once" fails.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptGroup, drainGroup, GROUP_LINES } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { LINES, setup } from "./groupWorld.testing";
import { answerHanded, failHanded, MAX_STARTS, TURN_KEY } from "./groupTurnRun";
import { ANSWER_RETRIES, runGroupTurn, type InboxCall } from "./groupTurnWorkflow";
import type { Fetch } from "./clients";

type StepConfig = { retries?: { limit: number } };

/** Workflows' `step.do`, inline: a step that throws runs again, up to its retry limit. */
function inlineStep() {
  const runs: string[] = [];
  const step = {
    async do<T>(name: string, ...rest: unknown[]): Promise<T> {
      const callback = rest.at(-1) as () => Promise<T>;
      const config = (rest.length > 1 ? rest[0] : {}) as StepConfig;
      let last: unknown;
      for (let attempt = 0; attempt <= (config.retries?.limit ?? 0); attempt += 1) {
        runs.push(name);
        try {
          return await callback();
        } catch (error) {
          last = error;
        }
      }
      throw last;
    },
  };
  return { step: step as Parameters<typeof runGroupTurn>[1], runs };
}

/** A chat whose turns go to a workflow: `started` names each instance, `run` sees one through. */
function handedWorld(groupId: string, opts: Parameters<typeof setup>[1] = {}) {
  const storage = new MemoryStorage();
  const w = setup(groupId, opts);
  const started: string[] = [];
  const deps = { ...w.deps, startTurn: async (turn: string) => void started.push(turn) };
  const inbox: InboxCall = async (path, turn) =>
    Response.json({ outcome: await (path === "/group-answer" ? answerHanded : failHanded)(storage, deps, turn) });
  const run = async (turn = started.at(-1)!) => {
    const { step, runs } = inlineStep();
    const outcome = await runGroupTurn({ inbox: "inbox", turn }, step, inbox);
    return { outcome, runs };
  };
  return { storage, w, deps, started, run };
}

afterEach(() => vi.restoreAllMocks());

for (const { name, groupId } of LINES) {
  describe(`a group turn's workflow, ${name}`, () => {
    it("the chat's object chooses the turn and hands it over; the workflow answers it", async () => {
      const { storage, w, deps, started, run } = handedWorld(groupId);
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, deps);
      expect(started).toHaveLength(1);
      expect(w.asks).toHaveLength(0);
      expect((await run()).outcome).toBe("done");
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what's on tonight"]);
      expect(w.texts).toContain("answer to Tex what's on tonight");
      expect(await storage.get(TURN_KEY)).toBeUndefined();
      expect([...(await storage.list({ prefix: "gpending:" })).keys()]).toEqual([]);
    });

    it("while a turn is handed over, the next waits for it, then gets its own", async () => {
      const { storage, w, deps, started, run } = handedWorld(groupId);
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, deps);
      await acceptGroup(storage, w.message("Tex and tomorrow?", { from: "+15555550102" }), 10);
      await drainGroup(storage, deps);
      expect(started).toHaveLength(1);
      await run();
      await drainGroup(storage, deps);
      expect(started).toHaveLength(2);
      await run();
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what's on tonight", "Tex and tomorrow?"]);
    });

    it("a turn that keeps failing is tried four times, then the chat is told once", async () => {
      const { storage, w, deps, run } = handedWorld(groupId);
      let tries = 0;
      const failing = (async (url: string, init?: RequestInit) => {
        if (new URL(url).pathname === "/agent") {
          tries += 1;
          return new Response("down", { status: 502 });
        }
        return await w.deps.fetch(url, init);
      }) as unknown as Fetch;
      deps.fetch = failing;
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, deps);
      const { outcome, runs } = await run();
      expect(outcome).toBe("failed");
      expect(tries).toBe(1 + ANSWER_RETRIES.limit);
      expect(runs.filter((name) => name === "answer")).toHaveLength(4);
      expect(w.texts.filter((text) => text === GROUP_LINES.failed)).toHaveLength(1);
      expect(await storage.get(TURN_KEY)).toBeUndefined();
      expect([...(await storage.list({ prefix: "gpending:" })).keys()]).toEqual([]);
    });

    it("the logs say a turn ran through the workflow, and on which attempt it answered or gave up", async () => {
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      const outcomes = () => logs.mock.calls.flat().map((line) => JSON.parse(String(line))).filter((l) => l.event === "group_turn");
      const ok = handedWorld(groupId);
      await acceptGroup(ok.storage, ok.w.message("Tex what's on tonight"), 0);
      await drainGroup(ok.storage, ok.deps);
      await ok.run();
      expect(outcomes().filter((l) => l.outcome.startsWith("workflow_") || l.outcome === "inline")).toEqual([
        { event: "group_turn", outcome: "workflow_started" },
        { event: "group_turn", outcome: "workflow_answered", attempts: 1 },
      ]);
      logs.mockClear();
      const bad = handedWorld(groupId);
      bad.deps.fetch = (async (url: string, init?: RequestInit) =>
        new URL(url).pathname === "/agent" ? new Response("down", { status: 502 }) : await bad.w.deps.fetch(url, init)) as unknown as Fetch;
      await acceptGroup(bad.storage, bad.w.message("Tex what's on tonight"), 0);
      await drainGroup(bad.storage, bad.deps);
      await bad.run();
      expect(outcomes().filter((l) => l.outcome === "failed").map((l) => l.attempts)).toEqual([1, 2, 3, 4]);
      expect(outcomes().find((l) => l.outcome === "workflow_gave_up")).toMatchObject({ attempts: 4 });
    });

    it("the same turn asked twice at once is answered once, and again after it is over not at all", async () => {
      const { storage, w, deps, started } = handedWorld(groupId);
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, deps);
      const turn = started[0];
      const both = await Promise.all([answerHanded(storage, deps, turn), answerHanded(storage, deps, turn)]);
      expect(both).toEqual(["done", "done"]);
      expect(await answerHanded(storage, deps, turn)).toBe("gone");
      expect(w.asks).toHaveLength(1);
      expect(w.texts.filter((text) => text === "answer to Tex what's on tonight")).toHaveLength(1);
    });

    it("a retry sends only what did not reach the chat the first time", async () => {
      const { storage, w, deps, run } = handedWorld(groupId, {
        agent: () => ({ answer: "First, the plan.\n\nSecond, the time.", verbatim: ["Second, the time."] }),
      });
      let sends = 0;
      deps.fetch = (async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        const isSend = path === "/api/send-group-message" || (new URL(url).host === "gate.whapi.cloud" && path.startsWith("/messages/") && !path.endsWith("/reaction"));
        // The second part fails once, after the first reached the chat.
        if (isSend && ++sends === 2) return new Response("busy", { status: 503 });
        return await w.deps.fetch(url, init);
      }) as unknown as Fetch;
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, deps);
      expect((await run()).outcome).toBe("done");
      expect(w.asks).toHaveLength(2);
      expect(w.texts.filter((text) => text === "First, the plan.")).toHaveLength(1);
      expect(w.texts.filter((text) => text === "Second, the time.")).toHaveLength(1);
      expect([...(await storage.list({ prefix: "gpart:" })).keys()]).toEqual([]);
    });

    it("a workflow that will not start is tried again, then the turn is answered here, logged as an error", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      let starts = 0;
      const deps = {
        ...w.deps,
        startTurn: async () => {
          starts += 1;
          throw new Error("no binding");
        },
      };
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      for (let alarm = 0; alarm < MAX_STARTS - 1; alarm += 1) {
        await drainGroup(storage, deps);
        expect(w.asks).toHaveLength(0);
      }
      await drainGroup(storage, deps);
      expect(starts).toBe(MAX_STARTS);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what's on tonight"]);
      expect(errors.mock.calls.flat().join(" ")).toContain('"outcome":"workflow_unavailable"');
      expect(await storage.get(TURN_KEY)).toBeUndefined();
    });
  });
}
