/**
 * What Tex sends into a group, and how each part is logged (`events.ts`);
 * moved out of `groupInbox.ts` whole, so the queue stays under its size limit.
 */

import { ServiceError } from "./clients";
import { MAX_CANDIDATES } from "./decide";
import { addEvent, type EventReason, type TexEvent } from "./events";
import { noteHandle } from "./replyQuote";
import { chatEvents } from "./chatRead";
import { groupLineFor, groupLineSeam, type GroupLineDeps, type GroupPlace } from "./groupLine";
import { shrinkPicture, type OutgoingPicture } from "./outgoing";
import { sendPicturePart, sendWords, type PartLine } from "./sendOne";
import type { ImagesLike } from "./attachments";
import type { Picture } from "./line";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";
import { sha256Hex } from "./groupChat";
import { writeTextTiming, type TimingDataset } from "./textTiming";
import { isControlWord } from "./controlWords";
import { keepThreaded } from "./threadedResend";

/** The handles of Tex's last thirty texts in this group, so an inline reply to one wakes it. */
export const SENT_KEY = "gsent";
export const MAX_SENT = 30;

type GroupSayDeps = GroupLineDeps & { now: () => number; images?: ImagesLike; hostPicture?: (picture: Picture) => Promise<string> };

/** A part a handed turn sent, by turn and position, as the hash of what it was (`groupTurnRun.ts`). */
const PART_PREFIX = "gpart:";
/**
 * The handed turns sending now in this chat (a group runs several side by side: `groupTurnRun.ts`), each with the
 * messages it answers (its parts are threaded under one of them) and the position of its next part. A fixed line
 * answered beside them (`groupBeside.ts`) is under another message: no turn's part.
 */
type Sending = { turn: string; under: readonly string[]; next: number };
const sending = new WeakMap<InboxStorage, Map<string, Sending>>();

/** While a handed turn runs (`turn`, answering the messages `under`), each part it sends is remembered; null ends that. */
export function sendingFor(storage: InboxStorage, turn: string, under: readonly string[] | null = []): void {
  let turns = sending.get(storage);
  if (turns === undefined) sending.set(storage, (turns = new Map()));
  if (under === null) turns.delete(turn);
  else turns.set(turn, { turn, under, next: 0 });
}

/** The running turn whose part a send under `under` is, if any. */
function scopeOf(storage: InboxStorage, under: string): Sending | undefined {
  for (const scope of sending.get(storage)?.values() ?? []) if (scope.under.includes(under)) return scope;
  return undefined;
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
  const scope = scopeOf(storage, under);
  if (scope === undefined) return await send();
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
export function logTiming({ arrivedAt, asking, answered, firstSent, sent, parts, turn = "" }: { arrivedAt: number; asking: number; answered: number; firstSent?: number; sent: number; parts: number; turn?: string }, dataset?: TimingDataset): void {
  console.log(JSON.stringify({ event: "group_turn_timing", waitMs: asking - arrivedAt, gatewayMs: answered - asking, sendMs: sent - answered, totalMs: sent - arrivedAt }));
  writeTextTiming(dataset, "group", { queueMs: asking - arrivedAt, gatewayMs: answered - asking, sendMs: sent - answered, toFirstTextMs: firstSent === undefined ? undefined : firstSent - arrivedAt, toLastTextMs: sent - arrivedAt, parts }, turn);
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
 * Where every group reply's time went, fixed lines such as "Tex, what can you see" included (a model turn adds
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
/** `plain`: sent straight into the chat, not under the message it answers (the conversation classifier's call, `apps/mcp/src/agent/respond.js`). */
export type SayMeta = { turn?: string; covers?: string[]; people?: string; system?: true; reason?: EventReason; plain?: true };

/** One text into the group, threaded under the message it answers, remembered so a reply to it wakes Tex, and logged. */
export async function say(storage: InboxStorage, deps: GroupSayDeps, message: Pick<GroupMessage, "line" | "groupId" | "messageId" | "reaction" | "answersTapback">, text: string, meta: SayMeta = {}): Promise<void> {
  if (isControlWord(text)) return; // a word meant for us, never a text (`controlWords.ts`)
  await once(storage, message.messageId, `text:${text}`, () => sayNow(storage, deps, message, text, meta));
}

/**
 * A progress line into the group (`groupModelTurn.ts`), as `say` sends it but kept once per turn by its words,
 * not its position: a retry never sends a line again, and the answer's parts keep their own positions however
 * many lines the retry says (`interleaved-updates.md`). Nor does a redraft, a new turn over the same messages,
 * send a line one before it sent over any of them.
 */
export async function sayProgress(storage: InboxStorage, deps: GroupSayDeps, message: Pick<GroupMessage, "line" | "groupId" | "messageId" | "reaction" | "answersTapback">, text: string, meta: SayMeta): Promise<void> {
  if (isControlWord(text)) return;
  const over = meta.covers ?? [];
  if (over.length > 0 && (await chatEvents(storage, message.groupId)).some((event) => event.from.kind === "tex" && event.delivered === true && event.text === text && (event.covers ?? []).some((cover) => over.includes(cover)))) return;
  const scope = scopeOf(storage, message.messageId);
  if (scope === undefined) return await sayNow(storage, deps, message, text, meta);
  const key = `${PART_PREFIX}${scope.turn}:progress:${await sha256Hex(text)}`;
  if ((await storage.get<string>(key)) !== undefined) return;
  await sayNow(storage, deps, message, text, meta);
  await storage.put(key, "sent");
}

async function sayNow(storage: InboxStorage, deps: GroupSayDeps, message: Pick<GroupMessage, "line" | "groupId" | "messageId" | "reaction" | "answersTapback">, text: string, meta: SayMeta): Promise<void> {
  await sendWords(groupPartLine(storage, deps, message, meta), text);
}

/**
 * Where an answer to this message threads: under it, or, for a tapback (queued as its line, or a held 👍), under the
 * Tex text it was on when that is known, else plain. Never under the tapback: Sendblue takes that send and then fails
 * to deliver it (error 5000, the Nov Babies form-fill answer, 2026-11-12).
 */
export function threadUnder(message: Pick<GroupMessage, "messageId" | "reaction" | "answersTapback">): string | undefined {
  if (message.answersTapback !== undefined) return message.answersTapback.on;
  return message.reaction !== undefined ? undefined : message.messageId;
}

/** This lane's way out for the one sender (`sendOne.ts`): the group line, under the message answered, and Tex's sent handles. */
function groupPartLine(storage: InboxStorage, deps: GroupSayDeps, message: Pick<GroupMessage, "line" | "groupId" | "messageId" | "reaction" | "answersTapback">, meta: SayMeta): PartLine<OutgoingPicture> {
  const place: GroupPlace = { line: message.line, groupId: message.groupId };
  const under = meta.plain ? undefined : threadUnder(message);
  return {
    sendText: async (text) => {
      const handle = await groupLineFor(groupLineSeam(deps), message.groupId).sendText(place, text, under);
      // A threaded send Sendblue fails after taking it goes again plain, once (`sendblueStatus.ts`).
      if (under !== undefined) await keepThreaded(storage, handle, { text, place: { kind: "group", ...place }, at: deps.now() });
      return handle;
    },
    sendPicture: async (picture) => {
      let url: string;
      try {
        const hosted = "url" in picture ? picture.url : deps.hostPicture ? await deps.hostPicture(await shrinkPicture(deps.images, picture)) : null;
        if (hosted === null) throw new Error("no host");
        url = hosted;
      } catch {
        log("picture_failed", "host");
        return null;
      }
      await groupLineFor(groupLineSeam(deps), message.groupId).sendMedia(place, url, under);
      return url;
    },
    // The words already went: throwing would answer the whole turn again (three "Here's the one-pager"s and
    // then "I couldn't answer that one", 2026-10-26), so a picture that won't send is said once, never retried.
    refused: (error) => (log("picture_failed", error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : "host"), true),
    remember: async (handle, _text, ev) => {
      if (handle === undefined) return;
      await noteHandle(storage, handle, ev); // a reply under it finds this event (`replyQuote.ts`)
      const sent = (await storage.get<string[]>(SENT_KEY)) ?? [];
      await storage.put(SENT_KEY, [...sent.filter((entry) => entry !== handle), handle].slice(-MAX_SENT));
    },
    log: (part, system) => logOut(storage, deps, message.groupId, part, system ? { system: true } : meta),
  };
}

export async function logOut(storage: InboxStorage, deps: GroupSayDeps, chat: string, part: Pick<TexEvent, "kind" | "text" | "delivered" | "reason">, meta: SayMeta): Promise<string> {
  // Only a turn's own words are Tex's; anything else Tex sends is the system's.
  const turn = meta.system ? undefined : meta.turn;
  return await addEvent(storage, {
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
  await sendPicturePart(groupPartLine(storage, deps, message, meta), picture);
}
