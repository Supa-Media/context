/**
 * What Tex sends into a group, and how each part is logged (`events.ts`);
 * moved out of `groupInbox.ts` whole, so the queue stays under its size limit.
 */

import { ServiceError } from "./clients";
import { MAX_CANDIDATES } from "./decide";
import { addEvent, kindOf, type EventReason, type TexEvent } from "./events";
import { groupLineFor, type GroupLineDeps, type GroupPlace } from "./groupLine";
import { PICTURE_FAILED, shrinkPicture, type OutgoingPicture } from "./outgoing";
import type { ImagesLike } from "./attachments";
import type { Picture } from "./line";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";
import { sha256Hex } from "./groupChat";
import { writeTextTiming, type TimingDataset } from "./textTiming";
import { isControlWord } from "./controlWords";

/** The handles of Tex's last thirty texts in this group, so an inline reply to one wakes it. */
export const SENT_KEY = "gsent";
export const MAX_SENT = 30;

type GroupSayDeps = GroupLineDeps & { now: () => number; images?: ImagesLike; hostPicture?: (picture: Picture) => Promise<string> };

/** A part a handed turn sent, by turn and position, as the hash of what it was (`groupTurnRun.ts`). */
const PART_PREFIX = "gpart:";
/**
 * The handed turn sending now in this chat, the messages it answers (its parts are threaded under one of them), and
 * the position of its next part. A fixed line answered beside it (`groupBeside.ts`) is under another message: not its part.
 */
const sending = new WeakMap<InboxStorage, { turn: string; under: readonly string[]; next: number }>();

/** While a handed turn runs (`turn`, answering the messages `under`), each part it sends is remembered; null ends that. */
export function sendingFor(storage: InboxStorage, turn: string | null, under: readonly string[] = []): void {
  if (turn === null) sending.delete(storage);
  else sending.set(storage, { turn, under, next: 0 });
}

/** Forget what a handed turn sent, once it is over. */
export async function dropParts(storage: InboxStorage, turn: string): Promise<void> {
  for (const key of (await storage.list({ prefix: `${PART_PREFIX}${turn}:` })).keys()) await storage.delete(key);
}

/**
 * Send one part, unless the same turn already sent this same part at this
 * same position: a workflow retry runs the turn again (`groupTurnWorkflow.ts`),
 * and what reached the chat the first time is not sent twice.
 */
async function once(storage: InboxStorage, under: string, part: string, send: () => Promise<void>): Promise<void> {
  const scope = sending.get(storage);
  if (scope === undefined || !scope.under.includes(under)) return await send();
  const key = `${PART_PREFIX}${scope.turn}:${scope.next++}`;
  const hash = await sha256Hex(part);
  if ((await storage.get<string>(key)) === hash) return;
  await send();
  await storage.put(key, hash);
}

/** One line per outcome, never a number, a name or the words. */
export function log(outcome: string, reason?: string): void {
  console.log(JSON.stringify({ event: "group_turn", outcome, ...(reason ? { reason } : {}) }));
}

/** Where an answered group turn's time went, from its first message in to its last bubble out: milliseconds only. */
export function logTiming({ arrivedAt, asking, answered, firstSent, sent, parts }: { arrivedAt: number; asking: number; answered: number; firstSent?: number; sent: number; parts: number }, dataset?: TimingDataset): void {
  console.log(JSON.stringify({ event: "group_turn_timing", waitMs: asking - arrivedAt, gatewayMs: answered - asking, sendMs: sent - answered, totalMs: sent - arrivedAt }));
  writeTextTiming(dataset, "group", { queueMs: asking - arrivedAt, gatewayMs: answered - asking, sendMs: sent - answered, toFirstTextMs: firstSent === undefined ? undefined : firstSent - arrivedAt, toLastTextMs: sent - arrivedAt, parts });
}

/**
 * A fixed reply's timing (the settings menu answered by code, never by the gateway), kept until the chat's next
 * model turn carries it to the chat's note (`fixed` on `/agent`, the gateway's `groupTiming.js`), where it can be
 * read beside the chat's history. Times and milliseconds only; the newest few.
 */
export type FixedTiming = { path: string; arrivedAt: number; sentAt: number; queueMs: number; startMs?: number; membersMs?: number; controlMs?: number; replyMs: number };
const FIXED_TIMING_KEY = "gfixedtiming";
const MAX_FIXED_TIMINGS = 5;
async function keepFixedTiming(storage: InboxStorage, timing: FixedTiming): Promise<void> {
  const kept = (await storage.get<FixedTiming[]>(FIXED_TIMING_KEY)) ?? [];
  await storage.put(FIXED_TIMING_KEY, [...kept, timing].slice(-MAX_FIXED_TIMINGS));
}
/** The fixed replies' timings for the next `/agent` call, taken so each reaches the note once. */
export async function fixedTimings(storage: InboxStorage): Promise<{ fixed?: FixedTiming[] }> {
  const kept = await storage.get<FixedTiming[]>(FIXED_TIMING_KEY);
  if (kept === undefined || kept.length === 0) return {};
  await storage.delete(FIXED_TIMING_KEY);
  return { fixed: kept };
}

/** Marks inside one group reply (`answerGroup`): after the app's member list, after the control plane's check, and which fixed path answered. */
export type ReplyClock = { mark(stage: "members" | "control"): void; path(name: string): void };

/**
 * Where every group reply's time went, fixed lines such as "Tex, settings" included (a model turn adds
 * `group_turn_timing` for its own part): `queueMs` from the first message in to the hand-off (the pause, a
 * turn ahead of it, decide), `startMs` from the hand-off to answering (the workflow starting, its retries),
 * then the member list, the control plane's check, and the reply itself. Milliseconds and a path name only.
 */
export async function timedReply<T>(storage: InboxStorage, arrivedAt: number, handedAt: number | undefined, now: () => number, answer: (clock: ReplyClock) => Promise<T>): Promise<T> {
  const started = now();
  const marks: { members?: number; control?: number } = {};
  let path = "turn";
  let fixed: FixedTiming | undefined;
  const done = (outcome: string) => {
    const end = now();
    const stages: Record<string, number> = {};
    let from = started;
    for (const [name, at] of [["membersMs", marks.members], ["controlMs", marks.control]] as const) if (at !== undefined) (stages[name] = at - from), (from = at);
    const start = handedAt === undefined ? {} : { startMs: started - handedAt };
    const queueMs = (handedAt ?? started) - arrivedAt;
    console.log(JSON.stringify({ event: "group_reply_timing", path, outcome, queueMs, ...start, ...stages, replyMs: end - from, totalMs: end - arrivedAt }));
    if (path !== "turn" && outcome === "done") fixed = { path, arrivedAt, sentAt: end, queueMs, ...start, ...stages, replyMs: end - from };
  };
  try {
    const result = await answer({ mark: (stage) => void (marks[stage] = now()), path: (name) => void (path = name) });
    done(result === "cancelled" ? "cancelled" : "done");
    if (fixed !== undefined) await keepFixedTiming(storage, fixed).catch(() => {});
    return result;
  } catch (error) {
    done("failed");
    throw error;
  }
}

/**
 * How a text Tex sends is logged (`events.ts`): a turn's, with its turn and
 * what it covers; a fixed line (`system`), with no turn, as the system's.
 */
export type SayMeta = { turn?: string; covers?: string[]; people?: string; system?: true; reason?: EventReason };

/** One text into the group, threaded under the message it answers, remembered so a reply to it wakes Tex, and logged. */
export async function say(storage: InboxStorage, deps: GroupSayDeps, message: Pick<GroupMessage, "line" | "groupId" | "messageId">, text: string, meta: SayMeta = {}): Promise<void> {
  if (isControlWord(text)) return; // a word meant for us, never a text (`controlWords.ts`)
  await once(storage, message.messageId, `text:${text}`, () => sayNow(storage, deps, message, text, meta));
}

async function sayNow(storage: InboxStorage, deps: GroupSayDeps, message: Pick<GroupMessage, "line" | "groupId" | "messageId">, text: string, meta: SayMeta): Promise<void> {
  const place: GroupPlace = { line: message.line, groupId: message.groupId };
  const handle = await groupLineFor(deps, message.groupId).sendText(place, text, message.messageId);
  await logOut(storage, deps, message.groupId, { kind: kindOf(text), text, delivered: true }, meta);
  if (handle === undefined) return;
  const sent = (await storage.get<string[]>(SENT_KEY)) ?? [];
  await storage.put(SENT_KEY, [...sent.filter((entry) => entry !== handle), handle].slice(-MAX_SENT));
}

export async function logOut(storage: InboxStorage, deps: GroupSayDeps, chat: string, part: Pick<TexEvent, "kind" | "text" | "delivered" | "reason">, meta: SayMeta): Promise<void> {
  // Only a turn's own words are Tex's; anything else Tex sends is the system's.
  const turn = meta.system ? undefined : meta.turn;
  await addEvent(storage, {
    at: deps.now(),
    chat,
    from: { kind: turn ? "tex" : "system" },
    ...part,
    ...(turn ? { turn } : {}),
    ...(turn && meta.covers?.length ? { covers: meta.covers.slice(-MAX_CANDIDATES) } : {}),
    ...(meta.people ? { people: meta.people } : {}),
    ...(meta.reason ? { reason: meta.reason } : {}),
  });
}

/** One picture into the chat; one the app refuses becomes a line saying so, as in a 1:1 text. */
export async function sendPicture(storage: InboxStorage, deps: GroupSayDeps, message: GroupMessage, picture: OutgoingPicture, meta: SayMeta): Promise<void> {
  await once(storage, message.messageId, `picture:${"url" in picture ? picture.url : `${picture.name}:${picture.data}`}`, () => sendPictureNow(storage, deps, message, picture, meta));
}

async function sendPictureNow(storage: InboxStorage, deps: GroupSayDeps, message: GroupMessage, picture: OutgoingPicture, meta: SayMeta): Promise<void> {
  let url: string | null = null;
  try {
    url = "url" in picture ? picture.url : deps.hostPicture ? await deps.hostPicture(await shrinkPicture(deps.images, picture)) : null;
    if (url === null) throw new ServiceError("sendblue", 400);
    await groupLineFor(deps, message.groupId).sendMedia({ line: message.line, groupId: message.groupId }, url, message.messageId);
    await logOut(storage, deps, message.groupId, { kind: "picture", text: url, delivered: true }, meta);
  } catch (error) {
    // The words already went: throwing would answer the whole turn again (three "Here's the one-pager"s and
    // then "I couldn't answer that one", 2026-10-26), so a picture that won't send is said once, never retried.
    log("picture_failed", error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : "host");
    await logOut(storage, deps, message.groupId, { kind: "picture", delivered: false, reason: url === null ? "upload_failed" : "send_refused" }, meta);
    await say(storage, deps, message, PICTURE_FAILED, { system: true });
  }
}

