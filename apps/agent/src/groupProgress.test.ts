/**
 * A group turn's progress lines (Dev2, 2026-11-01,
 * `docs/decisions/texting-assistant/interleaved-updates.md`): as many as the
 * turn sends, in order, each logged as Tex's, and only while nobody new is
 * here. Threading under the ask is `groupInbox.test.ts`'s; a retry is
 * `groupTurnWorkflow.test.ts`'s.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, acceptGroupRoutine, drainGroup, type GroupDeps } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { ADA, BO, CY, LINE, LINES, answerAll, setup, type Answer, type Decide } from "./groupWorld.testing";
import { recentEvents } from "./events";
import { CHAT_LOOK_PATH } from "./groupRoutines";
import { answerHanded, failHanded } from "./groupTurnRun";
import { runGroupTurn, type InboxCall } from "./groupTurnWorkflow";
import type { Fetch } from "./clients";

/** The chat's world, its turn streaming `lines` and then `answer`. */
function streaming(groupId: string, lines: string[], answer: string, members?: string[][], opts: Parameters<typeof setup>[1] = {}) {
  const w = setup(groupId, { members, ...opts });
  const fetch = w.deps.fetch;
  w.deps.fetch = (async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname !== "/agent") return await fetch(url, init);
    const out = [...lines.map((progress) => ({ progress })), { status: 200, body: { answer } }];
    return new Response(out.map((line) => JSON.stringify(line)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
  }) as unknown as Fetch;
  return w;
}

for (const { name, groupId } of LINES) {
  describe(`a group turn's progress lines, ${name}`, () => {
    it("are texted in order, each its own bubble, logged as Tex's under the turn", async () => {
      const storage = new MemoryStorage();
      const w = streaming(groupId, ["Checking OpenTable for Friday.", "Found 3 tables at Nopa.", "Reading their reviews."], "Nopa at 7, want it?");
      await acceptGroup(storage, w.message("Tex, find us a table Friday"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual(["Checking OpenTable for Friday.", "Found 3 tables at Nopa.", "Reading their reviews.", "Nopa at 7, want it?"]);
      const log = (await recentEvents(storage, groupId)).filter((event) => event.from.kind === "tex");
      expect(log.map((event) => [event.text, event.delivered])).toEqual([["Checking OpenTable for Friday.", true], ["Found 3 tables at Nopa.", true], ["Reading their reviews.", true], ["Nopa at 7, want it?", true]]);
      expect(log.every((event) => event.turn !== undefined && event.turn === log[0].turn)).toBe(true);
    });

    it("pause for good once someone new joins, each held line logged as held", async () => {
      const storage = new MemoryStorage();
      // Here when it starts and at the first line; Cy joins before the second, and has left again by the third.
      const w = streaming(groupId, ["Reading the page now.", "Found the pricing table.", "Comparing the plans."], "Plan B fits.", [[ADA, BO], [ADA, BO], [ADA, BO, CY], [ADA, BO]]);
      await acceptGroup(storage, w.message("Tex, research this"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts[0]).toBe("Reading the page now.");
      expect(w.texts).not.toContain("Found the pricing table.");
      expect(w.texts).not.toContain("Comparing the plans.");
      const held = (await recentEvents(storage, groupId)).filter((event) => event.reason === "held_newcomer").map((event) => event.text);
      expect(held).toEqual(["Found the pricing table.", "Comparing the plans."]);
    });

    it("are never said by a routine: a check-in that finds nothing posts nothing, and one that finds something posts only its answer", async () => {
      for (const [answer, posted] of [["SKIP", []], ["The venue moved load-in to 4pm.", ["The venue moved load-in to 4pm."]]] as const) {
        const storage = new MemoryStorage();
        const w = streaming(groupId, ["Checking the chat's shared mail."], answer);
        await acceptGroupRoutine(storage, { runId: `r_${answer.length}`, path: CHAT_LOOK_PATH, phone: ADA, line: LINE, groupId }, 0);
        await drainGroup(storage, w.deps);
        expect(w.texts).toEqual(posted);
      }
    });

    it("cost the chat a line when one won't send, never the turn's answer", async () => {
      const storage = new MemoryStorage();
      const w = streaming(groupId, ["Opening OpenTable for Friday.", "Reading the menu."], "Nopa at 7, want it?");
      const fetch = w.deps.fetch;
      w.deps.fetch = (async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if ((body.content ?? body.body) === "Opening OpenTable for Friday.") return new Response("down", { status: 500 });
        return await fetch(url, init);
      }) as unknown as Fetch;
      await acceptGroup(storage, w.message("Tex, find us a table Friday"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual(["Reading the menu.", "Nopa at 7, want it?"]);
    });

    it("are not said again by a redraft, a new turn over the same ask", async () => {
      const storage = new MemoryStorage();
      // Their newer words come in while the turn runs, wait their turn, and the draft no longer fits them: it is redone over both.
      const queue = (body: Decide): Answer => (body.running ? ({ ...answerAll(body), midTurn: "queue" } as Answer) : answerAll(body));
      const w = setup(groupId, { hold: true, decide: queue, recheck: () => ({ ok: true, fits: false }) });
      const fetch = w.deps.fetch;
      w.deps.fetch = (async (url: string, init?: RequestInit) => {
        if (new URL(url).pathname !== "/agent") return await fetch(url, init);
        const { answer } = (await (await fetch(url, init)).json()) as { answer: string };
        const out = [{ progress: "Checking everyone's calendars." }, { progress: "Found two open slots." }, { status: 200, body: { answer } }];
        return new Response(out.map((line) => JSON.stringify(line)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
      }) as unknown as Fetch;
      await acceptGroup(storage, w.message("Tex find us a time this week"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      await acceptGroup(storage, w.message("Tex actually make it next week"), 10);
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.rechecks).toHaveLength(1);
      expect(w.asks).toHaveLength(2);
      expect(w.texts).toEqual(["Checking everyone's calendars.", "Found two open slots.", "answer to Tex find us a time this week\nTex actually make it next week"]);
    });

    it("stop once the chat says stop, though the turn was already running", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { controlFor: (body) => ((body as { command?: { kind?: string } }).command?.kind === "stop" ? { status: "stopped" } : undefined) });
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let midway = () => {};
      const reached = new Promise<void>((resolve) => (midway = resolve));
      const base = w.deps.fetch;
      const started: string[] = [];
      const deps = { ...w.deps, startTurn: async (turn: string) => void started.push(turn) } as GroupDeps;
      const line = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
      deps.fetch = (async (url: string, init?: RequestInit) => {
        if (new URL(url).pathname !== "/agent") return await base(url, init);
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(line({ progress: "Checking the calendar." }));
            midway();
            await gate;
            controller.enqueue(line({ progress: "Reading Bo's notes." }));
            controller.enqueue(line({ status: 200, body: { answer: "Friday at 6 works." } }));
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
      }) as unknown as Fetch;
      const inbox: InboxCall = async (path, turn) => Response.json({ outcome: await (path === "/group-answer" ? answerHanded : failHanded)(storage, deps, turn) });
      const step = { do: async <T>(_name: string, ...rest: unknown[]) => await (rest.at(-1) as () => Promise<T>)() } as Parameters<typeof runGroupTurn>[1];
      await acceptGroup(storage, w.message("Tex when can we meet"), 0);
      await drainGroup(storage, deps);
      const turn = runGroupTurn({ inbox: "inbox", turn: started.at(-1)! }, step, inbox);
      await reached;
      await acceptGroup(storage, w.message("Tex, stop", { from: ADA }), 10);
      await drainGroup(storage, deps);
      release();
      await turn;
      const stopped = w.texts.findIndex((text) => text.startsWith("Okay, I'll stay quiet here"));
      expect(w.texts.slice(0, stopped)).toEqual(["Checking the calendar."]);
      expect(w.texts.slice(stopped + 1)).not.toContain("Reading Bo's notes.");
    });
  });
}
