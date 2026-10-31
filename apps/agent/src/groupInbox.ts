/**
 * One group chat's queue (iMessage or WhatsApp, `groupLine.ts`), kept in a
 * Durable Object named after the group (`sendblue-group:<group_id>`, the
 * name kept for the iMessage groups already queued), never in any one sender's: group
 * traffic never touches a person's own 1:1 object
 * (docs/decisions/texting-assistant/groups.md).
 *
 * Tex answers in a group when it is addressed: its name opening or closing
 * the message, its name in a question, or an inline reply to one of Tex's
 * own texts in this group. Which untagged messages decide also reads is the
 * group's style (`groupStyle.ts`); which waiting messages one turn answers,
 * and what a message during a running turn does, is decide's
 * (`groupTurn.ts`, Dev2, 2026-10-26, reversing "two people's texts are two
 * questions"). Decide down, only addressed messages are answered, one at a
 * time, as before. While the chat is bound, every untagged message is kept
 * until the next turn hands it over as what the chat said (`groupChat.ts`).
 *
 * Every tagged message is resolved again by the control plane
 * (`/agent-texts/group`): who is in the chat (Sendblue's webhook list and
 * its members read, together, so more people can only narrow it), and the
 * one shared workspace every one of them is a member of. A turn runs with a
 * grant to that workspace alone, and its answer goes out only if nobody new
 * joined while it ran.
 *
 * What it keeps, all without text unless said:
 * - `gpending:<seq>` holds a tagged message only until it is answered or
 *   given up on.
 * - `gseen:<eventId>:<hash>` a timestamp for a day, so a redelivered webhook
 *   is answered once; keyed by the words' hash too, so an edit Sendblue
 *   delivers under the same handle is read as the new message it is.
 * - `grecent` hashes of who tagged what in the last ten minutes, so the same
 *   ask sent twice is answered once (the group chat of 2026-10-21).
 * - `gask` who Tex last asked for a yes, for half an hour, never the words:
 *   their bare "yes" or "send" is then for Tex, not chat.
 * - `gsent` the handles of Tex's last thirty texts in this group, so an
 *   inline reply to one wakes it.
 * - `gchat:<seq>` what the chat said since Tex last answered, with text,
 *   only while it is bound (`groupChat.ts`).
 * - `ev:<id>` the chat's recent events, with text, buffered until the
 *   gateway writes them to the bound workspace's log (`events.ts`); an
 *   untagged message of a chat that is not bound is never one.
 * - `gstyle`, `gfollow`, `gengask` the group's style (`groupStyle.ts`); the
 *   last holds, for half an hour, the one message the style question held.
 * - `gnames` handles by the hash of a phone, never a number (`groupTurn.ts`).
 */

import { reportRoutineResult, ServiceError, type Fetch, type RoutineOutcome } from "./clients";
import { chatRoutineMessage, type ChatRoutineRun } from "./groupRoutines";
import { askControlPlane, type ControlAnswer, type GuestInfo } from "./groupControl";
import { noteGuestChat } from "./groupGuestPeople";
import { failedLine, GROUP_LINES, PICTURE_LINE } from "./groupLines";
export { askControlPlane, GROUP_LINES, PICTURE_LINE };
export type { Command, ControlAnswer, GuestInfo };
import { log, MAX_SENT, say, SENT_KEY, timedReply, type ReplyClock } from "./groupSay";
import type { Picture } from "./line";
import type { ImagesLike } from "./attachments";
import type { InboundAttachment } from "./inbound";
import { groupSettingReply, groupSettings } from "./groupSettings";
import { tapbackText, type Reaction } from "./reactions";
import { ackEmoji } from "./ackEmoji";
import { dropThumb, dueThumb, GROUP_THUMB_KEY, holdThumb } from "./thumbs";
import type { InboxStorage } from "./inbox";
import type { SendblueKeys } from "./sendblue";
import type { WhapiKeys } from "./whapi";
import { groupLineFor } from "./groupLine";
import type { NoteCardDrawer } from "./noteCards";
import { isBound, keepChatLine, peopleOf, setChatBound, sha256Hex } from "./groupChat";
import type { GroupMessage } from "./sendblueGroups";
import { watchFailed } from "./reviewWatch";
import { addressesTex, groupCommand, offeredName, unquoted, type Command } from "./groupWords";
import type { JobRun, JobSteer } from "./jobs";
import { armBy, flushChat, pruneEvents, type Conversation } from "./events";
import { reactionFor } from "./reactEmoji";
import { runningTurn } from "./steer";
import { chooseGroupTurn, WAIT_MS, coversOf, groupPendingKey as pendingKey, keepNames, logGroupInbound, mergedGroup, ownTurn, whileRunning, type GroupEntry, type GroupPending } from "./groupTurn";
import { chooseStyle } from "./groupChoose";
import { handedTurnWaits, handOff, TURN_KEY, type HandedTurn } from "./groupTurnRun";
import { answerBesideTurn } from "./groupBeside";
import { groupTurn } from "./groupModelTurn";
import { ENGAGEMENT_QUESTION, engagementChoice, expiredQuestion, groupStyle, keepQuestionAlarm, keepStyle, openQuestion, questionOpen, reachesDecide } from "./groupStyle";

export type GroupDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  gatewayOrigin: string;
  sendblue?: SendblueKeys | null;
  /** Tex's WhatsApp line (`whapi.ts`); absent, a WhatsApp group is not answered. */
  whapi?: WhapiKeys | null;
  /** Converts a photo the model cannot read (`attachments.ts`); absent, it is described instead. */
  images?: ImagesLike;
  hostPicture?: (picture: Picture) => Promise<string>; // a picture Tex sends, at a short-lived address Sendblue fetches (`media.ts`); absent, none go
  threadsLink?: () => Promise<string>; // a new link to the chat's live view of its jobs (`jobs.ts` `mintThreadsLink`)
  /** Draws a note link's picture, sent before the link (`noteCards.ts`); absent, the link goes alone. */
  noteCardPicture?: NoteCardDrawer;
  now: () => number;
  /** Starts a background job in an object of its own (`jobs.ts`); absent, the chat's turns are offered none. */
  spawnJob?: (id: string, run: JobRun) => Promise<void>;
  /** Hands a later text to a running job's object; true when it took it (`jobRun.ts`). */
  steerJob?: (id: string, steer: JobSteer) => Promise<boolean>;
  /** Starts the workflow that answers a chosen turn (`groupTurnWorkflow.ts`); absent, the turn is answered here. */
  startTurn?: (turn: string) => Promise<void>;
};

/** A group's queue is named apart from every phone's, which always starts with "+". */
export function groupInboxName(groupId: string): string {
  return `sendblue-group:${groupId}`;
}

type Pending = GroupPending;

const SEEN_FOR_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 10;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 20_000;
/** The workspace names Tex last asked this chat to pick from, never text: a bare "supa" then answers it. */
const CHOICE_KEY = "gchoice";
/** Until when decide said to wait on a burst still being typed (`WAIT_MS`). */
const WAIT_KEY = "gwaituntil";
const CHOICE_FOR_MS = 24 * 60 * 60 * 1000;
type Choice = { slugs: string[]; at: number };
const seenKey = (eventId: string, words: string) => `gseen:${eventId}:${words}`;
/** The same person tagging Tex with the same words this soon after is the same ask. */
export const SAME_ASK_MS = 10 * 60_000;
const RECENT_KEY = "grecent";
type Recent = { h: string; at: number };
/**
 * How long a tag waits before it is answered, so a picture sent just after it
 * ("Tex, file this screenshot", then the screenshot) is read with it, as a
 * 1:1 text's words wait for one (`inbox.ts` `TEXT_WAIT_MS`). 2s since Dev2, 2026-10-28 (was 4s): Tex felt slow.
 */
export const GROUP_TEXT_WAIT_MS = 2_000;
/** A picture from the person whose tag is still waiting joins that tag, this soon after it. */
export const PICTURE_JOINS_MS = 2 * 60_000;
/** The newest pictures and files a turn reads, its own and the chat's since Tex last answered. */
export const MAX_GROUP_FILES = 4;
/** How long a yes Tex asked for stays the asker's to give without its name. */
export const ASK_OPEN_MS = 30 * 60_000;
export const ASK_KEY = "gask";
export type OpenAsk = { from: string; at: number };
/** Words that only answer a yes Tex asked for: a yes, a no, or "send it" (`apps/mcp/src/agent/textedApprovals.js` decides what they settle). A bare "ok" stays chat: it is not a yes to a send there, and would only disarm the ask. */
const ANSWERS_ASK =
  /^\s*(?:yes|yes please|yep|yeah|yup|y|no|nope|cancel|send|send it|send that|file it|do it|go ahead|looks good)(?:[\s,.!-]+(?:send it|send|please|file it|do it|go ahead))*\s*[.!]*\s*$/i;


export { addressesTex, groupCommand, offeredName, peopleOf };

/**
 * Accept a group message. Addressed (or a yes, a style choice, a command): it
 * waits for the alarm. Not addressed: the group's style says whether decide
 * reads it (`groupStyle.ts`); otherwise it is kept as what the chat said
 * while the chat is bound, and dropped right here while it is not. While a
 * turn runs here, any message is decided with the turn running
 * (`groupTurn.ts`), except the ones code decides.
 */
export async function acceptGroup(storage: InboxStorage, message: GroupMessage, now: number): Promise<"queued" | "kept" | "ignored" | "duplicate" | "full"> {
  if (message.reaction !== undefined) return await acceptThumb(storage, message, message.reaction, now);
  const sent = (await storage.get<string[]>(SENT_KEY)) ?? [];
  const repliesToTex = message.replyTo !== undefined && sent.includes(message.replyTo);
  const choices = await openChoice(storage, now);
  const yes = await answersOpenAsk(storage, message, now);
  // An SMS never sets the style: anyone can send one that shows a member's number.
  const engagement = !message.sms && (await questionOpen(storage, now)) ? engagementChoice(message.text) : null;
  const setting = !message.sms && engagement === null ? await groupSettingReply(storage, message.text, now) : null;
  // A reply in Tex's thread is not addressed by itself: decide judges it, as any untagged text (Dev2, 2026-10-27).
  const addressed = addressesTex(message.text, false) || offeredName(message.text, choices) !== null;
  const tagged = addressed || yes || engagement !== null || setting !== null;
  const seen = seenKey(message.eventId, await sha256Hex(message.text));
  if ((await storage.get<number>(seen)) !== undefined) return tagged ? "duplicate" : "ignored";
  // Never the model's: an SMS (anyone can fake its sender), the asker's yes, a style choice, a command.
  const byCode = message.sms === true || yes || engagement !== null || setting !== null || (addressed && groupCommand(message.text, choices) !== null);
  const running = runningTurn(storage, message.groupId);
  // Untagged and idle: kept as chat if bound, and to decide as the style says. `ev` given: it was logged already.
  const idleUntagged = async (logged?: string): Promise<"kept" | "queued" | "ignored"> => {
    // Right after the sender's own waiting tag, it always goes to decide with it.
    const follows = await followsOwnTag(storage, message, now);
    // Kept as what the chat said only while it is bound; then the style says whether decide reads it too.
    const kept = await keepChatLine(storage, message, now);
    if (!kept && !follows) return log("untagged_ignored", "unbound"), "ignored";
    await storage.put(seen, now);
    const ev = logged ?? (await logGroupInbound(storage, message, now));
    // A reply to Tex that says more than thanks always reaches decide, whatever the style.
    const reaches = follows || addressesTex(message.text, repliesToTex) || (await reachesDecide(storage, (await groupStyle(storage)).style, await isAsker(storage, message, now)));
    if (reaches) await enqueue(storage, message, { ev, soft: true, ...(follows ? { joins: true as const } : {}) }, repliesToTex, seen, now);
    log(reaches ? "untagged_to_decide" : "untagged_kept", reaches ? undefined : "style");
    return kept ? "kept" : "queued";
  };
  if (!tagged && running === undefined) return await idleUntagged();
  // Untagged in a chat that is not bound: never logged, mid-turn or not (it would be dropped idle).
  if (!tagged && !(await isBound(storage, message)) && !(await followsOwnTag(storage, message, now))) return "ignored";
  // Nothing of an SMS group is logged: its sender vouches for nothing.
  const ev = message.sms ? undefined : await logGroupInbound(storage, message, now);
  const extra: Partial<Pending> = { ...(ev ? { ev } : {}), ...(byCode ? { byCode: true as const } : {}), ...(engagement ? { engagement } : {}), ...(setting ? { setting } : {}) };

  if (running !== undefined && ev !== undefined && !byCode) {
    // Seen before decide is asked: a webhook redelivered while decide is slow is a duplicate, never decided twice.
    await storage.put(seen, now);
    let how: Awaited<ReturnType<typeof whileRunning>>;
    try {
      how = await whileRunning(storage, message, ev, running, tagged, () => now, (emoji) =>
        groupLineFor(running.deps as GroupDeps, message.groupId).react({ line: message.line, groupId: message.groupId }, message.messageId, reactionFor(emoji, ackEmoji(message.text))),
      );
    } catch {
      // It is seen already: a throw here must not lose it, so it is queued as when no turn runs.
      return tagged ? await enqueue(storage, message, extra, repliesToTex, seen, now) : await idleUntagged(ev);
    }
    if (how === "folded") {
      await storage.put(seen, now);
      return "queued";
    }
    if (how === "after") return await enqueue(storage, message, { ...extra, force: true }, repliesToTex, seen, now);
    if (how === "redecide") {
      // Not addressed: chat, as any untagged line is, and put to decide once more after the turn.
      if (!tagged && !(await keepChatLine(storage, message, now))) return "ignored";
      return await enqueue(storage, message, { ...extra, ...(tagged ? {} : { soft: true as const }) }, repliesToTex, seen, now);
    }
    if (!(await keepChatLine(storage, message, now))) return "ignored";
    await storage.put(seen, now);
    return "kept";
  }
  if (!tagged) {
    if (!(await keepChatLine(storage, message, now))) return "ignored";
    await storage.put(seen, now);
    return "kept";
  }
  if (await askedJustNow(storage, message, now)) {
    await storage.put(seen, now);
    return "duplicate";
  }
  return await enqueue(storage, message, extra, repliesToTex, seen, now);
}

async function enqueue(storage: InboxStorage, message: GroupMessage, extra: Partial<Pending>, repliesToTex: boolean, seen: string, now: number): Promise<"queued" | "full"> {
  const pending = await storage.list<Pending>({ prefix: "gpending:" });
  if (pending.size >= MAX_PENDING) return "full";
  const seq = ((await storage.get<number>("gseq")) ?? 0) + 1;
  await storage.put("gseq", seq);
  await storage.put(seen, now);
  // Whether it replies to Tex is decided now, against the handles Tex sent; the turn reads the words it quotes.
  await storage.put<Pending>(pendingKey(seq), { message: repliesToTex ? message : { ...message, replyTo: undefined }, attempts: 0, at: now, ...extra });
  // Words alone wait a moment for a picture to follow them; a tag that brought one goes now.
  await storage.setAlarm(message.attachments?.length ? now : now + GROUP_TEXT_WAIT_MS);
  return "queued";
}

/** A chat routine's run (`groupRoutines.ts`): queued as its writer's tag, answered now. */
export async function acceptGroupRoutine(storage: InboxStorage, run: ChatRoutineRun, now: number): Promise<"queued" | "full"> {
  return await queueGroupByCode(storage, chatRoutineMessage(run), now);
}

/** Queue a turn this Worker asks for itself (a routine's run, a job's report: `jobTexts.ts`), as its writer's tag; once per event. */
export async function queueGroupByCode(storage: InboxStorage, message: GroupMessage, now: number): Promise<"queued" | "full"> {
  const seen = seenKey(message.eventId, ""); // One run, one turn: handed here again, it is already queued or answered.
  if ((await storage.get<number>(seen)) !== undefined) return "queued";
  const pending = await storage.list<Pending>({ prefix: "gpending:" });
  if (pending.size >= MAX_PENDING) return "full";
  const seq = ((await storage.get<number>("gseq")) ?? 0) + 1;
  await storage.put("gseq", seq);
  await storage.put<Pending>(pendingKey(seq), { message, attempts: 0, at: now, byCode: true });
  await storage.put(seen, now);
  await storage.setAlarm(now);
  return "queued";
}

/** How a chat routine's run went, to the control plane: a code, never its words. */
export async function routineDone(deps: GroupDeps, message: GroupMessage, outcome: RoutineOutcome, texted = 0): Promise<void> {
  if (message.routine === undefined) return;
  log(`routine_${outcome}`);
  if (message.jobReport !== undefined) return; // a job's report runs as a routine's turn does, but no run waits on it
  await reportRoutineResult(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, { runId: message.routine.runId, outcome, texted }).catch(() => log("routine_unreported"));
}

/**
 * Anything sent by someone whose tag is still waiting, a moment after it,
 * goes to decide with it whatever the style, so one turn can read both: the
 * screenshot after "Tex, file this screenshot as a bug report" (Jhon,
 * 2026-10-23, Tex answered that it couldn't see one), the link after "Tex
 * check this link out". Only their own tag, and only one sent a moment ago.
 */
async function followsOwnTag(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  // An SMS joins nothing: its sender can be faked.
  if (message.sms) return false;
  const pending = [...(await storage.list<Pending>({ prefix: "gpending:" })).values()];
  return pending.some((item) => item.message.from === message.from && item.attempts === 0 && !item.soft && now - (item.at ?? 0) < PICTURE_JOINS_MS);
}

/** The pictures and files a turn reads: the newest of its own and of what the chat sent since Tex last answered, oldest first. */
export function filesFor(message: GroupMessage, lines: readonly { attachments?: InboundAttachment[] }[]): InboundAttachment[] {
  const all = [...lines.flatMap((line) => line.attachments ?? []), ...(message.attachments ?? [])];
  return all.slice(-MAX_GROUP_FILES);
}

/**
 * A like on Tex's ask from the person it asked, which goes at once as their
 * yes (`thumbs.ts`). Anyone else's is ignored:
 * only the asker's yes can release what was held for them.
 */
async function acceptThumb(storage: InboxStorage, message: GroupMessage, reaction: Reaction, now: number): Promise<"queued" | "ignored"> {
  if (!(await isAsker(storage, message, now))) return "ignored";
  if (reaction.removed) {
    await dropThumb(storage, reaction.words, GROUP_THUMB_KEY);
    return "ignored";
  }
  await logGroupInbound(storage, message, now);
  await holdThumb<GroupMessage>(storage, { ...message, text: tapbackText(reaction.how) }, reaction.words, now, GROUP_THUMB_KEY);
  return "queued";
}

/** Whether this is from the person Tex last asked for a yes, while that ask is open. */
async function isAsker(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  const ask = await storage.get<OpenAsk>(ASK_KEY);
  return ask !== undefined && now - ask.at < ASK_OPEN_MS && ask.from === (await sha256Hex(message.from));
}

/**
 * Whether this person tagged Tex with these same words a moment ago (Jhon,
 * 2026-10-21: the same bug report sent twice was written up twice). Kept as
 * hashes of sender and words, never either. Remembers this ask either way.
 */
async function askedJustNow(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  const h = await sha256Hex(`${message.from}\n${message.text.replace(/\s+/g, " ").trim().toLowerCase()}`);
  const recent = ((await storage.get<Recent[]>(RECENT_KEY)) ?? []).filter((item) => now - item.at < SAME_ASK_MS);
  const again = recent.some((item) => item.h === h);
  await storage.put<Recent[]>(RECENT_KEY, [...recent.filter((item) => item.h !== h), { h, at: now }].slice(-MAX_SENT));
  return again;
}

/**
 * A bare yes, no or "send" from the person Tex just asked, while that ask is
 * open (Jhon's "yes" to the bug report, 2026-10-21, kept as chat). Anyone
 * else's is chat: only the asker's yes can release what was held for them.
 */
async function answersOpenAsk(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  if (!ANSWERS_ASK.test(unquoted(message.text))) return false;
  return await isAsker(storage, message, now);
}

/** Answer what is waiting, oldest first: code's messages one by one, the rest as decide groups them. Called from the alarm. */
export async function drainGroup(storage: InboxStorage, deps: GroupDeps): Promise<void> {
  try {
    await drainOnce(storage, deps);
  } finally {
    // One alarm per object: whatever set a sooner one, the style question's expiry and the events' day are kept.
    await pruneEvents(storage, deps.now());
    await keepQuestionAlarm(storage, deps.now());
  }
}

async function drainOnce(storage: InboxStorage, deps: GroupDeps): Promise<void> {
  // A 👍 on the ask joins the queue as the asker's answer.
  const thumb = await dueThumb<GroupMessage>(storage, deps.now(), GROUP_THUMB_KEY);
  if (thumb !== undefined) {
    const seq = ((await storage.get<number>("gseq")) ?? 0) + 1;
    await storage.put("gseq", seq);
    await storage.put<Pending>(pendingKey(seq), { message: thumb, attempts: 0, at: deps.now(), byCode: true });
  }
  // A style question nobody answered in time: the message it held is answered after all.
  const unanswered = await expiredQuestion<Pending>(storage, deps.now());
  if (unanswered !== undefined) {
    const seq = ((await storage.get<number>("gseq")) ?? 0) + 1;
    await storage.put("gseq", seq);
    await storage.put<Pending>(pendingKey(seq), { ...unanswered, attempts: 0, byCode: true, styleAsked: true });
  }
  for (let pass = 0; pass < 3 * MAX_PENDING; pass += 1) {
    // One model turn at a time: while a workflow answers one, the rest wait for it (`groupTurnRun.ts`); a fixed line goes now (`groupBeside.ts`).
    if (deps.startTurn !== undefined && (await handedTurnWaits(storage, deps))) {
      return void (await answerBesideTurn(storage, deps, (await storage.get<HandedTurn>(TURN_KEY))?.keys ?? [], await openChoice(storage, deps.now())));
    }
    const pending = [...(await storage.list<Pending>({ prefix: "gpending:" }))];
    if (pending.length === 0) break;
    let entries: GroupEntry[] = [pending[0]];
    if (!pending[0][1].byCode && pending[0][1].attempts === 0) {
      const burst: GroupEntry[] = [];
      for (const entry of pending) {
        if (entry[1].byCode) break;
        burst.push(entry);
      }
      // While a burst waits, a new message to it starts the wait again: it ends WAIT_MS after the newest, if that is later.
      const waitUntil = Math.max((await storage.get<number>(WAIT_KEY)) ?? 0, burst.some(([, item]) => item.waits) ? Math.max(...burst.map(([, item]) => item.at ?? 0)) + WAIT_MS : 0);
      if (deps.now() < waitUntil && burst.every(([, item]) => item.soft === true && item.force !== true)) { // An addressed one never waits.
        await armBy(storage, waitUntil, deps.now());
        break;
      }
      const choice = await chooseGroupTurn(storage, deps, burst);
      if (choice.wait !== undefined && choice.wait.length > 0) {
        for (const [key, item] of choice.wait) await storage.put<Pending>(key, { ...item, waits: (item.waits ?? 0) + 1 });
        const until = Math.max(deps.now(), ...choice.wait.map(([, item]) => item.at ?? 0)) + WAIT_MS; // From now: a wait decided late still waits
        await storage.put(WAIT_KEY, until);
        await armBy(storage, until, deps.now());
        log("waiting");
        if (choice.answer.length === 0) break;
      }
      // Left as chat: an untagged one is already one of the chat's lines (`acceptGroup`); an addressed one becomes one.
      for (const [key, item] of choice.chat) {
        if (!item.soft) await keepChatLine(storage, item.message, item.at ?? deps.now());
        await storage.delete(key);
      }
      for (const [key] of choice.drop) await storage.delete(key);
      if (choice.react) {
        await groupLineFor(deps, choice.react.groupId).react({ line: choice.react.line, groupId: choice.react.groupId }, choice.react.messageId, reactionFor(choice.emoji, ackEmoji(choice.react.text)));
      }
      entries = ownTurn(choice.answer);
      if (entries.length === 0) continue;
    }
    if (deps.startTurn !== undefined) return void (await handOff(storage, deps, entries)); // No Workflows binding: answered here.
    if (await answerInline(storage, entries, deps)) return;
  }
  await pruneSeen(storage, deps.now());
}

/** One turn answered here, as before workflows: retried by the alarm, then given up on. True when the drain stops for the retry. */
export async function answerInline(storage: InboxStorage, entries: GroupEntry[], deps: GroupDeps): Promise<boolean> {
  const [key, item] = entries.at(-1)!;
  // Which path ran it: inline means no workflow (`groupTurnRun.ts` logs workflow_started for the other).
  if (item.attempts === 0) log("inline");
  try {
    const outcome = await timedReply(storage, entries[0][1].at ?? deps.now(), undefined, deps.now, (clock) => answerGroup(storage, entries, deps, clock));
    // Restarted: what it covered waits, marked, for the turn that answers it with the newer message.
    if (outcome !== "cancelled") for (const [done] of entries) await storage.delete(done);
  } catch (error) {
    const attempts = item.attempts + 1;
    const reason = error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : "error";
    log("failed", reason);
    if (attempts < MAX_ATTEMPTS) {
      // Retried as the same turn: the others it covered go with it.
      for (const [other] of entries.slice(0, -1)) await storage.delete(other);
      await storage.put<Pending>(key, { ...item, message: mergedGroup(entries.map(([, entry]) => entry.message)), attempts, byCode: true, covers: coversOf(entries) });
      await storage.setAlarm(deps.now() + RETRY_MS);
      return true;
    }
    for (const [done] of entries) await storage.delete(done);
    await turnFailed(storage, deps, item.message, error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : undefined);
  }
  return false;
}

/** A turn given up on (`reason` as logged): a routine nobody asked for just now fails quietly; anyone else is told what broke, and the chat is scored (`watchFailed`). */
export async function turnFailed(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, reason: string | undefined): Promise<void> {
  if (message.routine !== undefined) await routineDone(deps, message, "failed");
  else await say(storage, deps, message, failedLine(reason), { system: true, reason: reason === "gateway:504" ? "timed_out" : "failed" }).catch(() => {}).then(() => watchFailed(storage, deps, message));
}

/** One turn for `entries`, as one message (`mergedGroup`). "cancelled" when a restart cancelled it: nothing of it was sent. */
export async function answerGroup(storage: InboxStorage, entries: GroupEntry[], deps: GroupDeps, clock?: ReplyClock): Promise<"cancelled" | void> {
  const item = entries.at(-1)![1];
  const message = mergedGroup(entries.map(([, entry]) => entry.message));
  // What the chat said before the first message it answers is its context; the rest it answers.
  const acceptedAt = entries[0][1].at ?? deps.now();
  const covers = coversOf(entries);
  const app = groupLineFor(deps, message.groupId);
  // A green-bubble group is never answered from anyone's notes: SMS vouches for no sender.
  if (message.sms) return void (await say(storage, deps, message, GROUP_LINES.sms, { system: true }));
  const chat = { line: message.line, groupId: message.groupId };
  const routine = message.routine !== undefined;
  const command = item.engagement || item.setting || routine ? null : groupCommand(message.text, await openChoice(storage, deps.now()));
  // The app's own list too: more people only ever narrows what Tex may use. Unread where the webhook names only the sender, it's retried (`groupLine.ts`).
  const members = await app.readMembers(chat);
  clock?.mark("members");
  if (members === null) log("members_unread");
  if (members === null && !routine && app.senderOnlyWebhook) throw new ServiceError("whapi", null);
  // A routine runs as its writer's tag only while Sendblue says they are in the chat: nothing else lists who is.
  if (routine && (members === null || !members.includes(message.from))) return void (await routineDone(deps, message, "no_chat"));
  const people = peopleOf(message.line, message.participants, members);
  const asked = await askControlPlane(deps, message, people, command);
  clock?.mark("control");
  const status = asked.status;
  const fixed = (text: string) => say(storage, deps, message, text, { system: true });
  // A chat that can't run it now is told nothing: nobody in it asked just now.
  if (routine && status !== "ready") return void (await routineDone(deps, message, "no_chat"));
  // A chat that isn't answering keeps nothing it was told.
  if (status === "muted" || status === "stopped" || status === "no_shared") await setChatBound(storage, null);
  if (status === "refused" || status === "muted") return log(status);
  // Read from the words alone, the same for every tagger linked or not, so it says nothing about who they are (`ackEmoji.ts`).
  if (command === null && message.reaction === undefined && !item.engagement && !item.setting && !routine && !("texStyle" in asked && asked.texStyle?.emoji === "less")) await app.react(chat, message.messageId, ackEmoji(message.text));
  if (status === "unknown_sender") return asked.tell === true ? void (await fixed(GROUP_LINES.unknown)) : log(status);
  if (status === "no_shared") return void (await fixed(GROUP_LINES.noShared));
  if (status === "not_shared") return void (await fixed(GROUP_LINES.notShared(asked.slugs)));
  if (status === "not_allowed") {
    return void (await fixed(command?.kind === "invite" ? GROUP_LINES.notOwner(asked.slug) : GROUP_LINES.notAllowed(asked.slug)));
  }
  if (status === "guests_off" || status === "invited") await noteGuestChat(storage, message, false);
  if (status === "invited") {
    await storage.delete(CHOICE_KEY);
    await setChatBound(storage, message);
    return void (await fixed(GROUP_LINES.invited(asked.slug, asked.count, asked.role)));
  }
  if (status === "mail_shared") return void (await fixed(GROUP_LINES.mailShared(asked.address, asked.narrowed)));
  if (status === "mail_unshared") return void (await fixed(GROUP_LINES.mailUnshared(asked.count)));
  if (status === "mail_refused") return void (await fixed(GROUP_LINES.mailRefused));
  if (status === "guests_off") return void (await fixed(GROUP_LINES.guestsOff));
  if (status === "stopped") return void (await fixed(GROUP_LINES.stopped));
  if (status === "started") return void (await fixed(GROUP_LINES.started));
  if (status === "choose") {
    await storage.put<Choice>(CHOICE_KEY, { slugs: asked.slugs, at: deps.now() });
    return void (await fixed(GROUP_LINES.choose(asked.slugs)));
  }
  if (status !== "ready") throw new ServiceError("control_plane", null);
  await storage.delete(CHOICE_KEY);
  // A routine's run carries no webhook people list (`chatRoutineMessage`): binding to it would bind the chat to nobody,
  // and every untagged text after it would be dropped as said in front of other people.
  if (!routine) {
    await setChatBound(storage, message);
    // That turn synced the chat's people; later messages send them again only when they change (`groupGuestPeople.ts`).
    await noteGuestChat(storage, message, asked.guest !== undefined);
  }
  await keepNames(storage, asked.names ?? []);
  if (asked.engagement !== undefined || asked.engagementChosen !== undefined) await keepStyle(storage, asked.engagement ?? "followAlong", asked.engagementChosen !== false);
  const guest = asked.guest;
  if (command?.kind === "use") return void (await fixed(guest ? GROUP_LINES.guestBound(asked.slug, guest) : GROUP_LINES.bound(asked.slug, asked.intro)));
  if (command?.kind === "status") return void (await fixed(guest ? GROUP_LINES.guestStatus(asked.slug, guest) : GROUP_LINES.status(asked.slug)));
  // "Tex, settings", a reply to its menu, or "Tex, less emoji" (`groupSettings.ts`).
  if (command?.kind === "settings" || command?.kind === "style" || command?.kind === "review_sharing" || item.setting) return clock?.path(command?.kind ?? "setting"), await groupSettings(storage, deps, message, command, item.setting, asked);
  if (item.engagement) return await chooseStyle(storage, deps, message, item.engagement, asked);
  if (asked.accessToken === undefined) throw new ServiceError("control_plane", null);
  // The chat's events reach its log before the turn reads it, written with the chat's own grant.
  const conversation: Conversation = { group: message.groupId };
  await flushChat(storage, deps, asked.accessToken, conversation, message.groupId, () => sha256Hex(message.from));
  // The introduction is one-shot (the control plane marks it given), so it goes before anything else.
  if (asked.intro) await fixed(guest ? GROUP_LINES.guestIntro(asked.slug, guest) : GROUP_LINES.intro(asked.slug));
  // The first time Tex is asked something in a group whose style nobody chose, it asks that first and holds the message.
  if (asked.engagementChosen === false && !item.styleAsked && !routine && message.reaction === undefined && !(await questionOpen(storage, deps.now()))) {
    await openQuestion<Pending>(storage, deps.now(), { ...item, message, covers });
    await fixed(ENGAGEMENT_QUESTION);
    return await flushChat(storage, deps, asked.accessToken, conversation, message.groupId, () => sha256Hex(message.from));
  }
  const covered = entries.map(([, entry]) => entry.message);
  const contextUntil = Math.max(acceptedAt, item.contextUntil ?? acceptedAt);
  const upTo = Math.max(acceptedAt, ...entries.map(([, entry]) => entry.at ?? 0));
  const outcome = await groupTurn(storage, deps, { message, covered, acceptedAt: contextUntil, upTo, arrivedAt: acceptedAt, covers, people, asked, accessToken: asked.accessToken });
  await flushChat(storage, deps, asked.accessToken, conversation, message.groupId, () => sha256Hex(message.from));
  return outcome;
}

/** The names this chat was asked to pick from, while that question is still open. */
async function openChoice(storage: InboxStorage, now: number): Promise<string[]> {
  const choice = await storage.get<Choice>(CHOICE_KEY);
  return choice !== undefined && now - choice.at < CHOICE_FOR_MS ? choice.slugs : [];
}

async function pruneSeen(storage: InboxStorage, now: number): Promise<void> {
  const seen = await storage.list<number>({ prefix: "gseen:" });
  for (const [key, at] of seen) if (now - at > SEEN_FOR_MS) await storage.delete(key);
}
