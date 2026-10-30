/**
 * A group turn handed to a Cloudflare Workflow (`groupTurnWorkflow.ts`;
 * decided by Dev2, 2026-10-27,
 * docs/decisions/texting-assistant/group-turn-workflow.md).
 *
 * The chat's object still chooses the turn (decide, `groupTurn.ts`) and still
 * runs it, because a turn reads and writes this object's storage throughout
 * and a message that lands meanwhile is steered into it here (`steer.ts`).
 * What moves to the workflow is the retrying: the workflow asks this object
 * to answer the turn (`/group-answer`), retries that with backoff when it
 * throws, and once it gives up asks for the failed line (`/group-failed`).
 * Each turn is then one instance on the Workflows dashboard, with its step,
 * its attempts and its error.
 *
 * `gturn` holds the one handed turn: its id (the instance's), the keys of the
 * waiting messages it answers, and how often its workflow failed to start.
 * While it is there, the drain starts nothing else, so a chat still answers
 * one turn at a time. A workflow that cannot be started is tried again on
 * the next alarms; after three, the turn is answered here as before, logged
 * as an error so it is never quiet.
 */

import type { InboxStorage } from "./inbox";
import type { GroupEntry, GroupPending } from "./groupTurn";
import { dropParts, say, sendingFor } from "./groupSay";
import { GROUP_LINES } from "./groupLines";
import { ServiceError } from "./clients";
import { answerGroup, turnFailed, type GroupDeps } from "./groupInbox";
import { watchFailed } from "./reviewWatch";
import { CHAT_LOOK_PATH } from "./groupRoutines";

export const TURN_KEY = "gturn";
/** `kind`: a chat routine's run or a check-in (`groupRoutines.ts`), for the logs; absent for a turn people asked for. */
export type HandedTurn = { id: string; keys: string[]; at: number; starts: number; started?: true; reason?: string; tries?: number; kind?: TurnKind };
export type TurnKind = "routine" | "heartbeat";
/** Failed starts before the turn is answered here instead. */
export const MAX_STARTS = 3;
export const START_RETRY_MS = 20_000;
/**
 * A started turn this old has outlived every attempt its workflow can make
 * (four answers of at most twenty minutes, with backoff between): its
 * workflow is gone, so it is given up on rather than holding the chat.
 */
export const TURN_STALE_MS = 2 * 60 * 60_000;

/** What `/group-answer` did: answered (or cancelled by a restart), failed (the workflow retries), or not this chat's turn any more. */
export type AnswerOutcome = "done" | "failed" | "gone";

/** Turns this object is answering right now, so a workflow retry that overlaps its first attempt waits for it instead of answering twice. */
const answering = new WeakMap<InboxStorage, Map<string, Promise<AnswerOutcome>>>();

/** Hand `entries` to a new workflow; a workflow that never starts ends the turn here (`start`). */
export async function handOff(storage: InboxStorage, deps: GroupDeps, entries: GroupEntry[]): Promise<boolean> {
  // `ownTurn` marks the last one with what the chat said before it: kept, as the workflow's answer reads it from here.
  for (const [key, item] of entries) await storage.put<GroupPending>(key, item);
  const routine = entries.at(-1)![1].message.routine;
  // A routine's run is one instance per run id (Dev2, 2026-10-28): starting it again finds that instance, never a second run.
  const id = routine === undefined ? crypto.randomUUID() : `routine-${routine.runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}`;
  const kind: TurnKind | undefined = routine === undefined ? undefined : routine.path === CHAT_LOOK_PATH ? "heartbeat" : "routine";
  const turn: HandedTurn = { id, keys: entries.map(([key]) => key), at: deps.now(), starts: 0, ...(kind ? { kind } : {}) };
  await storage.put(TURN_KEY, turn);
  return await start(storage, deps, turn);
}

/** Whether a handed turn holds the chat: started and not stale, or waiting to be started again. */
export async function handedTurnWaits(storage: InboxStorage, deps: GroupDeps): Promise<boolean> {
  const turn = await storage.get<HandedTurn>(TURN_KEY);
  if (turn === undefined) return false;
  if (turn.started) {
    if (deps.now() - turn.at < TURN_STALE_MS) return true;
    log("stale");
    await failHanded(storage, deps, turn.id);
    return false;
  }
  return await start(storage, deps, turn);
}

async function start(storage: InboxStorage, deps: GroupDeps, turn: HandedTurn): Promise<boolean> {
  try {
    await deps.startTurn!(turn.id);
    await storage.put<HandedTurn>(TURN_KEY, { ...turn, started: true });
    log("workflow_started", undefined, undefined, turn.kind);
    return true;
  } catch {
    const starts = turn.starts + 1;
    log("workflow_start_failed", undefined, undefined, turn.kind);
    if (starts < MAX_STARTS) {
      await storage.put<HandedTurn>(TURN_KEY, { ...turn, starts });
      await storage.setAlarm(deps.now() + START_RETRY_MS);
      return true;
    }
    // Loud: an error, so a broken binding or a Workflows outage is seen, never just slow.
    console.error(JSON.stringify({ event: "group_turn", outcome: "workflow_unavailable", ...(turn.kind ? { kind: turn.kind } : {}) }));
    await stuck(storage, deps, turn);
    return true;
  }
}

/**
 * No workflow after every try (Dev2, 2026-10-28): never answered here instead. The chat is told
 * once that Tex is stuck; a routine's run fails quietly, as any routine nobody asked for just now.
 */
async function stuck(storage: InboxStorage, deps: GroupDeps, turn: HandedTurn): Promise<void> {
  const entries = await entriesOf(storage, turn);
  for (const [key] of entries) await storage.delete(key);
  await storage.delete(TURN_KEY);
  // Whatever waited behind it is drained now, as after any turn (`finish`).
  await storage.setAlarm(deps.now());
  const last = entries.at(-1)?.[1].message;
  if (last === undefined) return;
  if (last.routine !== undefined) await turnFailed(storage, deps, last, undefined);
  else {
    await say(storage, deps, last, GROUP_LINES.stuck, { system: true, reason: "failed" }).catch(() => {});
    await watchFailed(storage, deps, last);
  }
}

/** `/group-answer`: answer the handed turn `id` here, once at a time. */
export async function answerHanded(storage: InboxStorage, deps: GroupDeps, id: string): Promise<AnswerOutcome> {
  let running = answering.get(storage);
  if (running === undefined) answering.set(storage, (running = new Map()));
  const already = running.get(id);
  if (already !== undefined) return await already;
  const work = answerOnce(storage, deps, id).finally(() => running.delete(id));
  running.set(id, work);
  return await work;
}

async function answerOnce(storage: InboxStorage, deps: GroupDeps, id: string): Promise<AnswerOutcome> {
  const turn = await storage.get<HandedTurn>(TURN_KEY);
  if (turn?.id !== id) return "gone";
  const entries = await entriesOf(storage, turn);
  if (entries.length === 0) return await finish(storage, deps, id);
  // Which attempt of the workflow's answer step this is, so a retry shows in the logs.
  const tries = (turn.tries ?? 0) + 1;
  await storage.put<HandedTurn>(TURN_KEY, { ...turn, tries });
  sendingFor(storage, id);
  try {
    const outcome = await answerGroup(storage, entries, deps);
    // Restarted: what it covered waits, marked, for the turn that answers it with the newer message.
    if (outcome !== "cancelled") for (const [key] of entries) await storage.delete(key);
  } catch (error) {
    const reason = error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : "error";
    log("failed", reason, tries, turn.kind);
    await storage.put<HandedTurn>(TURN_KEY, { ...turn, tries, reason });
    return "failed";
  } finally {
    sendingFor(storage, null);
  }
  log("workflow_answered", undefined, tries, turn.kind);
  return await finish(storage, deps, id);
}

/** `/group-failed`: the workflow gave up on turn `id`; the chat is told, as a turn given up on here is. */
export async function failHanded(storage: InboxStorage, deps: GroupDeps, id: string): Promise<AnswerOutcome> {
  const turn = await storage.get<HandedTurn>(TURN_KEY);
  if (turn?.id !== id) return "gone";
  const entries = await entriesOf(storage, turn);
  for (const [key] of entries) await storage.delete(key);
  log("workflow_gave_up", turn.reason, turn.tries, turn.kind);
  const last = entries.at(-1)?.[1];
  if (last !== undefined) await turnFailed(storage, deps, last.message, turn.reason);
  return await finish(storage, deps, id);
}

/** The turn is over: the chat is free, and whatever waited behind it is drained now. */
async function finish(storage: InboxStorage, deps: GroupDeps, id: string): Promise<"done"> {
  await storage.delete(TURN_KEY);
  await dropParts(storage, id);
  await storage.setAlarm(deps.now());
  return "done";
}

async function entriesOf(storage: InboxStorage, turn: HandedTurn): Promise<GroupEntry[]> {
  const entries: GroupEntry[] = [];
  for (const key of turn.keys) {
    const item = await storage.get<GroupPending>(key);
    if (item !== undefined) entries.push([key, item]);
  }
  return entries;
}

function log(outcome: string, reason?: string, attempts?: number, kind?: TurnKind): void {
  console.log(JSON.stringify({ event: "group_turn", outcome, ...(reason ? { reason } : {}), ...(attempts ? { attempts } : {}), ...(kind ? { kind } : {}) }));
}
