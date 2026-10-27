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
import { dropParts, sendingFor } from "./groupSay";
import { ServiceError } from "./clients";
import { answerGroup, answerInline, turnFailed, type GroupDeps } from "./groupInbox";

export const TURN_KEY = "gturn";
export type HandedTurn = { id: string; keys: string[]; at: number; starts: number; started?: true; reason?: string };
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

/** Hand `entries` to a new workflow. False only when no workflow could be started: the caller answers them itself. */
export async function handOff(storage: InboxStorage, deps: GroupDeps, entries: GroupEntry[]): Promise<boolean> {
  // `ownTurn` marks the last one with what the chat said before it: kept, as the workflow's answer reads it from here.
  for (const [key, item] of entries) await storage.put<GroupPending>(key, item);
  const turn: HandedTurn = { id: crypto.randomUUID(), keys: entries.map(([key]) => key), at: deps.now(), starts: 0 };
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
  if (await start(storage, deps, turn)) return true;
  // No workflow after every try: answered here, as before.
  const entries = await entriesOf(storage, turn);
  if (entries.length > 0 && (await answerInline(storage, entries, deps))) return true;
  return false;
}

async function start(storage: InboxStorage, deps: GroupDeps, turn: HandedTurn): Promise<boolean> {
  try {
    await deps.startTurn!(turn.id);
    await storage.put<HandedTurn>(TURN_KEY, { ...turn, started: true });
    return true;
  } catch {
    const starts = turn.starts + 1;
    log("workflow_start_failed");
    if (starts < MAX_STARTS) {
      await storage.put<HandedTurn>(TURN_KEY, { ...turn, starts });
      await storage.setAlarm(deps.now() + START_RETRY_MS);
      return true;
    }
    // Loud: an error, so a broken binding or a Workflows outage is seen, never just slow.
    console.error(JSON.stringify({ event: "group_turn", outcome: "workflow_unavailable" }));
    await storage.delete(TURN_KEY);
    return false;
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
  sendingFor(storage, id);
  try {
    const outcome = await answerGroup(storage, entries, deps);
    // Restarted: what it covered waits, marked, for the turn that answers it with the newer message.
    if (outcome !== "cancelled") for (const [key] of entries) await storage.delete(key);
  } catch (error) {
    const reason = error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : "error";
    log("failed", reason);
    await storage.put<HandedTurn>(TURN_KEY, { ...turn, reason });
    return "failed";
  } finally {
    sendingFor(storage, null);
  }
  return await finish(storage, deps, id);
}

/** `/group-failed`: the workflow gave up on turn `id`; the chat is told, as a turn given up on here is. */
export async function failHanded(storage: InboxStorage, deps: GroupDeps, id: string): Promise<AnswerOutcome> {
  const turn = await storage.get<HandedTurn>(TURN_KEY);
  if (turn?.id !== id) return "gone";
  const entries = await entriesOf(storage, turn);
  for (const [key] of entries) await storage.delete(key);
  const last = entries.at(-1)?.[1];
  if (last !== undefined) await turnFailed(storage, deps, last.message, turn.reason?.endsWith(":504") === true);
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

function log(outcome: string, reason?: string): void {
  console.log(JSON.stringify({ event: "group_turn", outcome, ...(reason ? { reason } : {}) }));
}
