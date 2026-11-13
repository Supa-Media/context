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
 * `gturn:<id>` holds each handed turn: its id (the instance's), the keys of
 * the waiting messages it answers, its asker, and how often its workflow
 * failed to start. Up to `MAX_GROUP_TURNS` run side by side, one per asker
 * (Dev2, 2026-11-13, one turn per text): somebody else's text starts its own
 * turn rather than waiting, and the asker's own next text waits for theirs
 * unless it is steered in (`steer.ts`). A workflow that cannot be started is
 * tried again on the next alarms; after three, the chat is told Tex is stuck,
 * logged as an error so it is never quiet.
 */

import type { InboxStorage } from "./inbox";
import type { GroupEntry, GroupPending } from "./groupTurn";
import { dropParts, say, sendingFor, timedReply } from "./groupSay";
import { GROUP_LINES } from "./groupLines";
import { ServiceError } from "./clients";
import { answerGroup, turnFailed, type GroupDeps } from "./groupInbox";
import { watchFailed } from "./reviewWatch";
import { CHAT_LOOK_PATH } from "./groupRoutines";
import { armBy } from "./events";
import { chatEvent } from "./chatState";

/** Each handed turn is kept at `gturn:<id>`; `gturn` alone is where a chat kept its one turn before 2026-11-13. */
export const TURN_PREFIX = "gturn:";
const LEGACY_TURN_KEY = "gturn";
export const turnKey = (id: string): string => `${TURN_PREFIX}${id}`;
/** Turns one group chat runs at once (the one-turn-per-text design's cap: the gateway's memory, 2026-11-08). */
export const MAX_GROUP_TURNS = 3;
/**
 * `kind`: a chat routine's run or a check-in (`groupRoutines.ts`), for the logs; absent for a turn people asked for.
 * `asker`: who the turn answers, as the line names them (absent on a turn handed before 2026-11-13).
 * `retryAt`: a workflow that did not start is tried again from then, not on every pass of the drain.
 */
export type HandedTurn = { id: string; keys: string[]; at: number; starts: number; started?: true; inline?: true; reason?: string; tries?: number; kind?: TurnKind; asker?: string; retryAt?: number };
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
/** An inline turn's watch: by then the object looks whether it is still answering, and hands a lost one to its workflow. */
export const INLINE_WATCH_MS = 60_000;

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
  const turn: HandedTurn = { id, keys: entries.map(([key]) => key), at: deps.now(), starts: 0, asker: entries.at(-1)![1].message.from, ...(kind ? { kind } : {}) };
  // Answered here first (Dev2, 2026-10-31: starting a workflow cost 1 to 2 s of every reply); its workflow only retries one that failed.
  if (deps.answerFirst !== undefined) return await answerFirst(storage, deps, { ...turn, inline: true });
  await storage.put(turnKey(id), turn);
  return await start(storage, deps, turn);
}

/**
 * Answer the turn in this object at once, beside the drain (`deps.answerFirst` keeps it running), and start its
 * workflow only when that answer fails: the workflow retries it as it would its own first attempt, and a part already
 * sent is never sent again (`sendingFor`). It counts against the chat's cap while it runs (`liveTurns`), and an alarm a minute
 * on looks whether it still runs; an object that restarted mid-answer hands it to its workflow then.
 */
async function answerFirst(storage: InboxStorage, deps: GroupDeps, turn: HandedTurn): Promise<boolean> {
  await storage.put(turnKey(turn.id), turn);
  await armBy(storage, deps.now() + INLINE_WATCH_MS, deps.now());
  log("inline_started", undefined, undefined, turn.kind);
  const work = answerHanded(storage, deps, turn.id).then(async (outcome) => {
    if (outcome !== "failed") return;
    const now = await storage.get<HandedTurn>(turnKey(turn.id));
    if (now !== undefined) await start(storage, deps, { ...now, inline: undefined });
  });
  deps.answerFirst!(work.catch(() => {}));
  return true;
}

/** Every handed turn this chat keeps, oldest first; one kept under the old single key moves to its own. */
export async function handedTurns(storage: InboxStorage): Promise<HandedTurn[]> {
  const legacy = await storage.get<HandedTurn>(LEGACY_TURN_KEY);
  if (legacy !== undefined) {
    await storage.put(turnKey(legacy.id), legacy);
    await storage.delete(LEGACY_TURN_KEY);
  }
  return [...(await storage.list<HandedTurn>({ prefix: TURN_PREFIX })).values()].sort((a, b) => a.at - b.at);
}

/**
 * The handed turns still running, each looked at first: an inline one lost to a restart goes to its workflow, a
 * stale one is given up on, one whose workflow did not start is started again. What is left counts against the cap.
 */
export async function liveTurns(storage: InboxStorage, deps: GroupDeps): Promise<HandedTurn[]> {
  for (const turn of await handedTurns(storage)) {
    if (turn.inline) {
      if (answering.get(storage)?.has(turn.id)) {
        await armBy(storage, deps.now() + INLINE_WATCH_MS, deps.now());
        continue;
      }
      // Not running here: the object restarted mid-answer. Its workflow answers it, skipping any part already sent.
      log("inline_lost", undefined, undefined, turn.kind);
      await start(storage, deps, { ...turn, inline: undefined });
      continue;
    }
    if (turn.started) {
      if (deps.now() - turn.at < TURN_STALE_MS) continue;
      log("stale");
      await failHanded(storage, deps, turn.id);
      continue;
    }
    if (turn.retryAt === undefined || deps.now() >= turn.retryAt) await start(storage, deps, turn);
  }
  return await handedTurns(storage);
}

async function start(storage: InboxStorage, deps: GroupDeps, turn: HandedTurn): Promise<boolean> {
  try {
    await deps.startTurn!(turn.id);
    await storage.put<HandedTurn>(turnKey(turn.id), { ...turn, started: true, inline: undefined, retryAt: undefined });
    log("workflow_started", undefined, undefined, turn.kind);
    return true;
  } catch {
    const starts = turn.starts + 1;
    log("workflow_start_failed", undefined, undefined, turn.kind);
    if (starts < MAX_STARTS) {
      await storage.put<HandedTurn>(turnKey(turn.id), { ...turn, starts, retryAt: deps.now() + START_RETRY_MS });
      await armBy(storage, deps.now() + START_RETRY_MS, deps.now());
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
  await storage.delete(turnKey(turn.id));
  await chatEvent(storage, "failed", "stuck", { now: deps.now() });
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
  await handedTurns(storage); // a turn handed before the move to one key per turn
  const turn = await storage.get<HandedTurn>(turnKey(id));
  if (turn === undefined) return "gone";
  const entries = await entriesOf(storage, turn);
  if (entries.length === 0) return await finish(storage, deps, id, "done");
  // Which attempt of the workflow's answer step this is, so a retry shows in the logs.
  const tries = (turn.tries ?? 0) + 1;
  await storage.put<HandedTurn>(turnKey(id), { ...turn, tries });
  sendingFor(storage, id, entries.map(([, item]) => item.message.messageId));
  let cancelled = false;
  try {
    const outcome = await timedReply(storage, entries[0][1].at ?? turn.at, turn.at, deps.now, (clock) => answerGroup(storage, entries, deps, clock));
    // Restarted: what it covered waits, marked, for the turn that answers it with the newer message.
    if (outcome !== "cancelled") for (const [key] of entries) await storage.delete(key);
    cancelled = outcome === "cancelled";
  } catch (error) {
    const reason = error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : "error";
    log("failed", reason, tries, turn.kind);
    await storage.put<HandedTurn>(turnKey(id), { ...turn, tries, reason });
    return "failed";
  } finally {
    sendingFor(storage, id, null);
  }
  log("workflow_answered", undefined, tries, turn.kind);
  return await finish(storage, deps, id, cancelled ? "cancelled" : "done");
}

/** `/group-failed`: the workflow gave up on turn `id`; the chat is told, as a turn given up on here is. */
export async function failHanded(storage: InboxStorage, deps: GroupDeps, id: string): Promise<AnswerOutcome> {
  await handedTurns(storage);
  const turn = await storage.get<HandedTurn>(turnKey(id));
  if (turn === undefined) return "gone";
  const entries = await entriesOf(storage, turn);
  for (const [key] of entries) await storage.delete(key);
  log("workflow_gave_up", turn.reason, turn.tries, turn.kind);
  const last = entries.at(-1)?.[1];
  if (last !== undefined) await turnFailed(storage, deps, last.message, turn.reason);
  return await finish(storage, deps, id, "failed");
}

/** The turn is over (`how`: answered, cancelled by a restart, or given up on): its place is free, and whatever waited for it is drained now. */
async function finish(storage: InboxStorage, deps: GroupDeps, id: string, how: "done" | "cancelled" | "failed"): Promise<"done"> {
  await storage.delete(turnKey(id));
  await chatEvent(storage, how, "turn", { now: deps.now() });
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
