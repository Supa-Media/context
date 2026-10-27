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

import { askAgentStream, askLine, reportRoutineResult, ServiceError, type AgentAnswer, type Fetch, type RoutineOutcome } from "./clients";
import { chatRoutineMessage, saysSkip, type ChatRoutineRun } from "./groupRoutines";
import { askControlPlane, type ControlAnswer, type GuestInfo } from "./groupControl";
import { noteGuestChat } from "./groupGuestPeople";
import { GROUP_LINES, PICTURE_LINE } from "./groupLines";
export { askControlPlane, GROUP_LINES, PICTURE_LINE };
export type { ControlAnswer, GuestInfo };
export type { Command };
import { MAX_SENT, say, sendPicture, SENT_KEY, type SayMeta } from "./groupSay";
import type { Picture } from "./line";
import { prepareAttachments, type ImagesLike } from "./attachments";
import type { InboundAttachment } from "./inbound";
import { textsWithExact } from "./format";
import { tapbackText, type Reaction } from "./reactions";
import { ackEmoji } from "./ackEmoji";
import { dropThumb, dueThumb, GROUP_THUMB_KEY, holdThumb } from "./thumbs";
import type { InboxStorage } from "./inbox";
import type { SendblueKeys } from "./sendblue";
import type { WhapiKeys } from "./whapi";
import { groupLineFor } from "./groupLine";
import type { NoteCardDrawer } from "./noteCards";
import { chatBefore, dropChatLines, isBound, keepChatLine, notePeople, peopleHash, peopleOf, setChatBound, sha256Hex } from "./groupChat";
import type { GroupMessage } from "./sendblueGroups";
import { watchConversation } from "./reviewWatch";
import { addressesTex, groupCommand, offeredName, unquoted, type Command } from "./groupWords";
import { chatJobs, startJobs, steerJobs, type JobRun, type JobSteer } from "./jobs";
import { addEvent, flushChat, kindOf, logAsk, pruneEvents, type Conversation } from "./events";
import { staleAsks } from "./decide";
import { runningTurn, startTurn } from "./steer";
import { chooseGroupTurn, coversOf, groupPendingKey as pendingKey, keepNames, logGroupInbound, mergedGroup, ownTurn, whileRunning, type GroupEntry, type GroupPending } from "./groupTurn";
import { chooseStyle } from "./groupChoose";
import { ENGAGEMENT_QUESTION, engagementChoice, expiredQuestion, groupStyle, keepQuestionAlarm, keepStyle, openQuestion, questionOpen, reachesDecide, texSpoke } from "./groupStyle";

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
  /** Serves a picture Tex sends at a short-lived address Sendblue fetches (`media.ts`); absent, pictures aren't sent. */
  hostPicture?: (picture: Picture) => Promise<string>;
  /** Draws a note link's picture, sent before the link (`noteCards.ts`); absent, the link goes alone. */
  noteCardPicture?: NoteCardDrawer;
  now: () => number;
  /** Starts a background job in an object of its own (`jobs.ts`); absent, the chat's turns are offered none. */
  spawnJob?: (id: string, run: JobRun) => Promise<void>;
  /** Hands a later text to a running job's object; true when it took it (`jobRun.ts`). */
  steerJob?: (id: string, steer: JobSteer) => Promise<boolean>;
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
 * 1:1 text's words wait for one (`inbox.ts` `TEXT_WAIT_MS`).
 */
export const GROUP_TEXT_WAIT_MS = 4_000;
/** A picture from the person whose tag is still waiting joins that tag, this soon after it. */
export const PICTURE_JOINS_MS = 2 * 60_000;
/** The newest pictures and files a turn reads, its own and the chat's since Tex last answered. */
export const MAX_GROUP_FILES = 4;
/** How long a yes Tex asked for stays the asker's to give without its name. */
export const ASK_OPEN_MS = 30 * 60_000;
const ASK_KEY = "gask";
type OpenAsk = { from: string; at: number };
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
  const addressed = addressesTex(message.text, repliesToTex) || offeredName(message.text, choices) !== null;
  const tagged = addressed || yes || engagement !== null;
  const seen = seenKey(message.eventId, await sha256Hex(message.text));
  if ((await storage.get<number>(seen)) !== undefined) return tagged ? "duplicate" : "ignored";
  // Never the model's: an SMS (anyone can fake its sender), the asker's yes, a style choice, a command.
  const byCode = message.sms === true || yes || engagement !== null || (addressed && groupCommand(message.text, choices) !== null);
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
    const reaches = follows || (await reachesDecide(storage, (await groupStyle(storage)).style, await isAsker(storage, message, now)));
    if (reaches) await enqueue(storage, message, { ev, soft: true, ...(follows ? { joins: true as const } : {}) }, repliesToTex, seen, now);
    log(reaches ? "untagged_to_decide" : "untagged_kept", reaches ? undefined : "style");
    return kept ? "kept" : "queued";
  };
  if (!tagged && running === undefined) return await idleUntagged();
  // Untagged in a chat that is not bound: never logged, mid-turn or not (it would be dropped idle).
  if (!tagged && !(await isBound(storage, message)) && !(await followsOwnTag(storage, message, now))) return "ignored";
  // Nothing of an SMS group is logged: its sender vouches for nothing.
  const ev = message.sms ? undefined : await logGroupInbound(storage, message, now);
  const extra: Partial<Pending> = { ...(ev ? { ev } : {}), ...(byCode ? { byCode: true as const } : {}), ...(engagement ? { engagement } : {}) };

  if (running !== undefined && ev !== undefined && !byCode) {
    // Seen before decide is asked: a webhook redelivered while decide is slow is a duplicate, never decided twice.
    await storage.put(seen, now);
    let how: Awaited<ReturnType<typeof whileRunning>>;
    try {
      how = await whileRunning(storage, message, ev, running, tagged, () => now, () =>
        groupLineFor(running.deps as GroupDeps, message.groupId).react({ line: message.line, groupId: message.groupId }, message.messageId, ackEmoji(message.text)),
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

async function enqueue(
  storage: InboxStorage,
  message: GroupMessage,
  extra: Partial<Pending>,
  repliesToTex: boolean,
  seen: string,
  now: number,
): Promise<"queued" | "full"> {
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
  const pending = await storage.list<Pending>({ prefix: "gpending:" });
  if (pending.size >= MAX_PENDING) return "full";
  const seq = ((await storage.get<number>("gseq")) ?? 0) + 1;
  await storage.put("gseq", seq);
  await storage.put<Pending>(pendingKey(seq), { message: chatRoutineMessage(run), attempts: 0, at: now, byCode: true });
  await storage.setAlarm(now);
  return "queued";
}

/** How a chat routine's run went, to the control plane: a code, never its words. */
async function routineDone(deps: GroupDeps, message: GroupMessage, outcome: RoutineOutcome, texted = 0): Promise<void> {
  if (message.routine === undefined) return;
  log(`routine_${outcome}`);
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
    const pending = [...(await storage.list<Pending>({ prefix: "gpending:" }))];
    if (pending.length === 0) break;
    let entries: GroupEntry[] = [pending[0]];
    if (!pending[0][1].byCode && pending[0][1].attempts === 0) {
      const burst: GroupEntry[] = [];
      for (const entry of pending) {
        if (entry[1].byCode) break;
        burst.push(entry);
      }
      const choice = await chooseGroupTurn(storage, deps, burst);
      // Left as chat: an untagged one is already one of the chat's lines (`acceptGroup`); an addressed one becomes one.
      for (const [key, item] of choice.chat) {
        if (!item.soft) await keepChatLine(storage, item.message, item.at ?? deps.now());
        await storage.delete(key);
      }
      for (const [key] of choice.drop) await storage.delete(key);
      if (choice.react) {
        await groupLineFor(deps, choice.react.groupId).react({ line: choice.react.line, groupId: choice.react.groupId }, choice.react.messageId, ackEmoji(choice.react.text));
      }
      entries = ownTurn(choice.answer);
      if (entries.length === 0) continue;
    }
    const [key, item] = entries.at(-1)!;
    try {
      const outcome = await answerGroup(storage, entries, deps);
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
        return;
      }
      for (const [done] of entries) await storage.delete(done);
      const timedOut = error instanceof ServiceError && error.status === 504;
      // A routine nobody asked for just now fails quietly: the chat didn't ask, so it is told nothing.
      if (item.message.routine !== undefined) await routineDone(deps, item.message, "failed");
      else await say(storage, deps, item.message, GROUP_LINES.failed, { system: true, reason: timedOut ? "timed_out" : "failed" }).catch(() => {});
    }
  }
  await pruneSeen(storage, deps.now());
}

/** One turn for `entries`, as one message (`mergedGroup`). "cancelled" when a restart cancelled it: nothing of it was sent. */
async function answerGroup(storage: InboxStorage, entries: GroupEntry[], deps: GroupDeps): Promise<"cancelled" | void> {
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
  const command = item.engagement || routine ? null : groupCommand(message.text, await openChoice(storage, deps.now()));

  // The app's own list too: more people only ever narrows what Tex may use.
  const members = await app.readMembers(chat);
  if (members === null) log("members_unread");
  // A routine runs as its writer's tag only while Sendblue says they are in the chat: nothing else lists who is.
  if (routine && (members === null || !members.includes(message.from))) return void (await routineDone(deps, message, "no_chat"));
  const people = peopleOf(message.line, message.participants, members);
  const asked = await askControlPlane(deps, message, people, command);
  const status = asked.status;
  const fixed = (text: string) => say(storage, deps, message, text, { system: true });
  // A chat that can't run it now is told nothing: nobody in it asked just now.
  if (routine && status !== "ready") return void (await routineDone(deps, message, "no_chat"));
  // A chat that isn't answering keeps nothing it was told.
  if (status === "muted" || status === "stopped" || status === "no_shared") await setChatBound(storage, null);
  if (status === "refused" || status === "muted") return log(status);
  // Read from the words alone, the same for every tagger linked or not, so it says nothing about who they are (`ackEmoji.ts`).
  if (command === null && message.reaction === undefined && !item.engagement && !routine) await app.react(chat, message.messageId, ackEmoji(message.text));
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
  await setChatBound(storage, message);
  // That turn synced the chat's people; later messages send them again only when they change (`groupGuestPeople.ts`).
  await noteGuestChat(storage, message, asked.guest !== undefined);
  await keepNames(storage, asked.names ?? []);
  if (asked.engagement !== undefined || asked.engagementChosen !== undefined) await keepStyle(storage, asked.engagement ?? "followAlong", asked.engagementChosen !== false);
  const guest = asked.guest;
  if (command?.kind === "use") return void (await fixed(guest ? GROUP_LINES.guestBound(asked.slug, guest) : GROUP_LINES.bound(asked.slug, asked.intro)));
  if (command?.kind === "status") return void (await fixed(guest ? GROUP_LINES.guestStatus(asked.slug, guest) : GROUP_LINES.status(asked.slug)));
  // "Tex, settings": the style question again (`groupStyle.ts`).
  if (command?.kind === "settings") {
    await openQuestion(storage, deps.now());
    return void (await fixed(ENGAGEMENT_QUESTION));
  }
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
  const outcome = await groupTurn(storage, deps, { message, covered, acceptedAt: contextUntil, covers, people, asked, accessToken: asked.accessToken });
  await flushChat(storage, deps, asked.accessToken, conversation, message.groupId, () => sha256Hex(message.from));
  return outcome;
}

type TurnInput = {
  message: GroupMessage;
  /** The messages it answers, one by one. */
  covered: GroupMessage[];
  acceptedAt: number;
  covers: string[];
  people: string[];
  asked: Extract<ControlAnswer, { status: "ready" }>;
  accessToken: string;
};

/** The model's turn on a group message, its answer sent only to the people it was written for. */
async function groupTurn(storage: InboxStorage, deps: GroupDeps, { message, covered, acceptedAt, covers, people, asked, accessToken }: TurnInput): Promise<"cancelled" | void> {
  const app = groupLineFor(deps, message.groupId);
  const chat = { line: message.line, groupId: message.groupId };
  const guest = asked.guest;
  const routine = message.routine !== undefined;
  const quoted = message.replyTo === undefined ? null : await app.readOwnMessage(chat, message.replyTo);
  const kept = await chatBefore(storage, message, acceptedAt, deps.now());
  // A chat line this turn answers is its question, not what the chat said around it.
  const asked_ = new Set(covered.map((entry) => `${entry.from}\n${entry.text}`));
  const said = { keys: kept.keys, lines: kept.lines.filter((line) => !asked_.has(`${line.from}\n${line.text}`)) };
  const handles = new Map((asked.names ?? []).map(({ phone, handle }) => [phone, handle]));
  // A guest is named in the chat's lines by a label from the control plane, never by number; never offered an email.
  const labels = new Map((asked.guests ?? []).map(({ phone, label }) => [phone, label]));
  // Pictures sent in the chat are read, as a 1:1 text's are (the group chat of 2026-10-23).
  const files = filesFor(message, said.lines);
  const attachments = files.length > 0 ? await prepareAttachments(files, { fetch: deps.fetch, images: deps.images }) : [];
  const group = {
    key: await sha256Hex(`${message.line}:${message.groupId}`),
    members: await peopleHash(message.line, people),
    ...(asked.handle ? { from: asked.handle } : {}),
    // Who is here, by handle, so an email can be offered to one of them to send (`apps/mcp/src/tools/offerFor.js`).
    people: [...new Set(handles.values())].filter(Boolean),
    ...(guest ? { guest } : {}),
    // Mailboxes shared with this chat, named for the turn; the control plane decides every read (`chat-mail.md`).
    ...(asked.mail?.length ? { mail: asked.mail } : {}),
  };
  // The chat's next events are filed under the people this turn named the gateway (`eventPeople`).
  await notePeople(storage, message, group.members);
  // Named, so a message that lands while it runs can be folded into it (`steer.ts`), and those it took in are not answered again.
  const { steer, end, live } = startTurn(storage, message.groupId, message.from, deps, covers, (ids) => dropSteered(storage, ids, covers));
  await steer.onSession(accessToken);
  const meta: SayMeta = { turn: steer.turn, covers, people: group.members };
  /*
    Asked for as a stream, as a person's own text is (the owner, 2026-10-23:
    "group Tex should literally be the same exact as DM Tex"): a long ask
    texts its progress into the chat while it works, each line only while
    nobody new has joined, the same check the answer gets below.
  */
  const progress = async (text: string) => {
    const now = await app.readMembers(chat);
    if (now === null || now.some((phone) => phone !== message.line && !people.includes(phone))) return;
    await say(storage, deps, message, text, meta);
  };
  let answer: AgentAnswer;
  try {
    answer = await askAgentStream(
      deps.fetch,
      deps.gatewayOrigin,
      accessToken,
      {
        question: message.text,
        group: { ...group, chat: said.lines.map((line) => ({ from: handles.get(line.from) ?? labels.get(line.from) ?? "", text: line.text || PICTURE_LINE })) },
        turn: steer.turn,
        ...(covers.length > 0 ? { covers, chat: message.groupId } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(asked.timeZone ? { timeZone: asked.timeZone } : {}),
        ...(deps.spawnJob ? { running: await chatJobs(storage, deps.now()) } : {}),
        ...(message.reaction !== undefined
          ? { quoted: message.reaction.words, tapback: message.reaction.how }
          : quoted !== null
            ? { quoted }
            : message.replyTo !== undefined
              ? { replied: true }
              : {}),
      },
      progress,
    );
  } finally {
    end();
  }
  if (live.cancelled || answer.kind === "cancelled") {
    // Cancelled here though its answer came: what it armed is never left armed and unseen.
    if (answer.kind === "answer" && answer.askIds) await staleAsks(deps, accessToken, answer.askIds);
    return "cancelled";
  }
  if (routine && answer.kind !== "answer") return void (await routineDone(deps, message, answer.kind === "daily_limit" ? "daily_limit" : answer.kind === "no_model" ? "no_provider" : "failed"));
  if (answer.kind === "daily_limit") return void (await say(storage, deps, message, "That's all the questions for today. Ask me again tomorrow.", { system: true }));
  if (answer.kind === "no_model") return void (await say(storage, deps, message, "I can't answer from here yet.", { system: true }));
  if (answer.kind !== "answer") throw new ServiceError("gateway", answer.kind === "unavailable" && answer.timedOut ? 504 : null);
  if (answer.steered) await dropSteered(storage, answer.steered, covers);
  // Filed in the chat's memory by that turn: this object's copy goes.
  await dropChatLines(storage, said.keys);
  // An answer that asks for a yes leaves it open for the one person it asks: the
  // asker, or the person an email is offered to (`askFor`); any other answer closes it.
  const asks = answer.askFor !== undefined ? [...handles].find(([, handle]) => handle === answer.askFor)?.[0] : message.from;
  if ((answer.verbatim?.length ?? 0) > 0 && asks !== undefined) await storage.put<OpenAsk>(ASK_KEY, { from: await sha256Hex(asks), at: deps.now() });
  else await storage.delete(ASK_KEY);

  // Sent only to the people it was written for: someone who joined meanwhile was never part of its scope.
  //
  // A list that could not be read is not a list with nobody new in it. On the
  // way in, falling back to the webhook's own names is safe because more names
  // only ever narrow the workspace the chat may use; here the fallback would
  // run the other way, and this is the only thing standing between an answer
  // drawn from the bound workspace and somebody who is not a member of it. So
  // an unreadable list holds the answer, as a joiner does.
  if (routine && saysSkip(answer.text) && (answer.verbatim?.length ?? 0) === 0 && answer.pictures.length === 0) return void (await routineDone(deps, message, "skipped"));
  const texts = textsWithExact(answer.text, answer.verbatim);
  const now = await app.readMembers(chat);
  if (now === null || now.some((phone) => phone !== message.line && !people.includes(phone))) {
    log(now === null ? "members_unread_after" : "joined");
    if (routine) return void (await routineDone(deps, message, now === null ? "failed" : "no_chat"));
    // Held for the newcomer: logged as never delivered, and the chat is told why.
    for (const text of texts) await addEvent(storage, { at: deps.now(), chat: message.groupId, from: { kind: "tex" }, kind: kindOf(text), text, delivered: false, reason: "held_newcomer", ...meta });
    return void (await say(storage, deps, message, now === null ? GROUP_LINES.failed : GROUP_LINES.joined, { system: true, ...(now === null ? { reason: "failed" as const } : {}) }));
  }
  // Every bubble under the message it answers, not only the first (Jhon's bug report, 2026-10-21).
  for (const text of texts) await say(storage, deps, message, text, meta);
  // A picture Tex drew, made or sent from a note, after the words, as in a 1:1 text.
  for (const picture of answer.pictures) await sendPicture(storage, deps, message, picture, meta);
  // Each ask is the asked person's: only their words can make it stale, only their session disarms it.
  const askedWho = await sha256Hex(asks ?? message.from);
  for (const record of answer.askIds ?? []) await logAsk(storage, { at: deps.now(), chat: message.groupId, from: { kind: "tex" }, turn: meta.turn, people: meta.people }, record, askedWho, askLine(answer));
  await texSpoke(storage);
  log("answered");
  await routineDone(deps, message, "answered", texts.length > 0 ? 1 : 0);
  // Twenty quiet minutes from now, this conversation is scored (`reviewWatch.ts`).
  await watchConversation(storage, { kind: "group", message, people }, deps.now());
  // Long asks it handed off run beside the chat (`jobs.ts`), each re-checking who is here when it answers.
  if (answer.jobs && deps.spawnJob) {
    await startJobs(storage, answer.jobs, {
      now: deps.now(),
      inbox: groupInboxName(message.groupId),
      origin: { kind: "group", message, at: acceptedAt },
      place: { line: message.line, groupId: message.groupId, messageId: message.messageId },
      spawn: deps.spawnJob,
    });
  }
  // A change to a job still running is handed to it, in the words of whoever texted it.
  if (answer.steers && deps.steerJob) await steerJobs(storage, answer.steers, { id: message.eventId, text: message.text }, deps.steerJob, deps.now());
}

/** Drop the waiting messages a turn took in as it ran; it answered them, so its answer covers them. */
async function dropSteered(storage: InboxStorage, ids: string[], covers: string[]): Promise<void> {
  for (const [key, item] of await storage.list<Pending>({ prefix: "gpending:" })) {
    if (!ids.includes(item.message.eventId)) continue;
    if (item.ev !== undefined && !covers.includes(item.ev)) covers.push(item.ev);
    await storage.delete(key);
  }
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

/** One line per outcome, never a number, a name or the words. */
function log(outcome: string, reason?: string): void {
  console.log(JSON.stringify({ event: "group_turn", outcome, ...(reason ? { reason } : {}) }));
}
