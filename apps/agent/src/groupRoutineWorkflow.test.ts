/**
 * A chat routine's run, and a check-in, seen through by the group turn's
 * workflow (Dev2, 2026-10-28; docs/decisions/texting-assistant/group-turn-workflow.md).
 *
 * Workflows itself is not run here: `step` runs each step inline, as many
 * times as its retry limit allows plus one.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `acceptGroupRoutine` without its seen check → "a run handed over twice
 *    is one turn and one instance" fails;
 *  - `handOff` naming a routine's instance at random → the same test fails.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptGroupRoutine, drainGroup, type GroupDeps } from "./groupInbox";
import { CHAT_LOOK_PATH, type ChatRoutineRun } from "./groupRoutines";
import { isBound, setChatBound } from "./groupChat";
import { answerHanded, failHanded, TURN_KEY } from "./groupTurnRun";
import { runGroupTurn, type InboxCall } from "./groupTurnWorkflow";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Fetch } from "./clients";
import type { GroupMessage } from "./sendblueGroups";

const LINE = "+15555550199";
const ADA = "+15555550101";
const BO = "+15555550102";
const GROUP = "11111111-2222-3333-4444-555555555555";
const RUN: ChatRoutineRun = { runId: "run_abc123", path: "tex/routines/daily/shifts.md", phone: ADA, line: LINE, groupId: GROUP };

type World = { sends: string[]; results: Record<string, unknown>[]; agentStatus: number; members: string[] };

function world(storage: MemoryStorage, w: World) {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/api/v2/groups/")) return Response.json({ data: { group_id: GROUP, participants: w.members.map((number) => ({ number })) } });
    const body = JSON.parse(String(init.body));
    if (path === "/api/send-group-message") {
      w.sends.push(body.content);
      return Response.json({ message_handle: `h_out_${w.sends.length}` });
    }
    if (path === "/api/send-reaction") return Response.json({});
    if (path === "/agent-texts/group") return Response.json({ status: "ready", slug: "crystal-care", intro: false, bound: true, timeZone: "UTC", handle: "ada", minted: true, accessToken: "cat_group" });
    if (path === "/agent-texts/routines/result") {
      w.results.push(body);
      return Response.json({ status: "recorded" });
    }
    if (path === "/agent") return w.agentStatus === 200 ? Response.json({ answer: "On shift today: Bo." }) : new Response("down", { status: w.agentStatus });
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  const started: string[] = [];
  const deps: GroupDeps = {
    fetch: fetcher,
    controlPlaneOrigin: "https://control.example.test",
    workerSecret: "secret",
    gatewayOrigin: "https://gateway.example.test",
    sendblue: { keyId: "id", secret: "key" },
    now: () => 1_000,
    startTurn: async (turn: string) => void started.push(turn),
  } as GroupDeps;
  const inbox: InboxCall = async (path, turn) => Response.json({ outcome: await (path === "/group-answer" ? answerHanded : failHanded)(storage, deps, turn) });
  /** One workflow instance, its steps inline. */
  const runWorkflow = async (turn = started.at(-1)!) => {
    const step = {
      async do<T>(_name: string, ...rest: unknown[]): Promise<T> {
        const callback = rest.at(-1) as () => Promise<T>;
        const limit = ((rest.length > 1 ? rest[0] : {}) as { retries?: { limit: number } }).retries?.limit ?? 0;
        let last: unknown;
        for (let attempt = 0; attempt <= limit; attempt += 1) {
          try {
            return await callback();
          } catch (error) {
            last = error;
          }
        }
        throw last;
      },
    };
    return await runGroupTurn({ inbox: "inbox", turn }, step as Parameters<typeof runGroupTurn>[1], inbox);
  };
  return { deps, started, runWorkflow };
}

const fresh = (): World => ({ sends: [], results: [], agentStatus: 200, members: [ADA, BO] });
const turnLogs = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.flat().flatMap((line) => {
    try {
      const parsed = JSON.parse(String(line));
      return parsed.event === "group_turn" ? [parsed] : [];
    } catch {
      return [];
    }
  });

afterEach(() => vi.restoreAllMocks());

describe("a chat routine's run through the workflow", () => {
  it("a run handed over twice is one turn and one instance, named by its run id", async () => {
    const storage = new MemoryStorage();
    const w = fresh();
    const { deps, started, runWorkflow } = world(storage, w);
    expect(await acceptGroupRoutine(storage, RUN, 1_000)).toBe("queued");
    expect(await acceptGroupRoutine(storage, RUN, 1_001)).toBe("queued");
    await drainGroup(storage, deps);
    expect(started).toEqual(["routine-run_abc123"]);
    expect(await runWorkflow()).toBe("done");
    // Handed over again after it answered: nothing new is queued or started.
    expect(await acceptGroupRoutine(storage, RUN, 2_000)).toBe("queued");
    await drainGroup(storage, deps);
    expect(started).toEqual(["routine-run_abc123"]);
    expect(w.sends).toEqual(["On shift today: Bo."]);
    expect(w.results).toEqual([{ runId: "run_abc123", outcome: "answered", texted: 1 }]);
  });

  it("is retried, then reported failed quietly: never a failed line in the chat", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    const w = { ...fresh(), agentStatus: 502 };
    const { deps, runWorkflow } = world(storage, w);
    await acceptGroupRoutine(storage, RUN, 1_000);
    await drainGroup(storage, deps);
    expect(await runWorkflow()).toBe("failed");
    expect(w.sends).toEqual([]);
    expect(w.results).toEqual([{ runId: "run_abc123", outcome: "failed", texted: 0 }]);
    const outcomes = turnLogs(logs);
    expect(outcomes.find((l) => l.outcome === "workflow_started")).toMatchObject({ kind: "routine" });
    expect(outcomes.filter((l) => l.outcome === "failed").map((l) => l.attempts)).toEqual([1, 2, 3, 4]);
    expect(outcomes.find((l) => l.outcome === "workflow_gave_up")).toMatchObject({ kind: "routine", attempts: 4 });
  });

  it("runs only while its writer is in the chat, and never rebinds the chat", async () => {
    const storage = new MemoryStorage();
    const said: GroupMessage = { kind: "group-message", eventId: "e1", groupId: GROUP, line: LINE, from: BO, participants: [LINE, ADA, BO], messageId: "m1", text: "hi" };
    await setChatBound(storage, said);
    const gone = { ...fresh(), members: [BO] };
    const left = world(storage, gone);
    await acceptGroupRoutine(storage, RUN, 1_000);
    await drainGroup(storage, left.deps);
    await left.runWorkflow();
    expect(gone.results).toEqual([{ runId: "run_abc123", outcome: "no_chat", texted: 0 }]);
    const here = fresh();
    const stayed = world(storage, here);
    await acceptGroupRoutine(storage, { ...RUN, runId: "run_def456" }, 2_000);
    await drainGroup(storage, stayed.deps);
    await stayed.runWorkflow();
    expect(here.results[0]).toMatchObject({ outcome: "answered" });
    expect(await isBound(storage, said)).toBe(true);
  });

  it("waits for a turn already handed over in the chat, then gets its own", async () => {
    const storage = new MemoryStorage();
    const w = fresh();
    const { deps, started, runWorkflow } = world(storage, w);
    await storage.put(TURN_KEY, { id: "people-turn", keys: [], at: 1_000, starts: 0, started: true });
    await acceptGroupRoutine(storage, RUN, 1_000);
    await drainGroup(storage, deps);
    expect(started).toEqual([]);
    expect(await answerHanded(storage, deps, "people-turn")).toBe("done");
    await drainGroup(storage, deps);
    expect(started).toEqual(["routine-run_abc123"]);
    await runWorkflow();
    expect(w.sends).toEqual(["On shift today: Bo."]);
  });

  it("a check-in is logged as a heartbeat", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    const { deps, runWorkflow } = world(storage, fresh());
    await acceptGroupRoutine(storage, { ...RUN, path: CHAT_LOOK_PATH, runId: "run_look1" }, 1_000);
    await drainGroup(storage, deps);
    await runWorkflow();
    expect(turnLogs(logs).filter((l) => l.outcome.startsWith("workflow_"))).toEqual([
      { event: "group_turn", outcome: "workflow_started", kind: "heartbeat" },
      { event: "group_turn", outcome: "workflow_answered", attempts: 1, kind: "heartbeat" },
    ]);
  });
});
