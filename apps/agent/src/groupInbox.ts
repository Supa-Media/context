/**
 * One group chat's queue (iMessage or WhatsApp, `groupLine.ts`), kept in a
 * Durable Object named after the group (`sendblue-group:<group_id>`, the
 * name kept for the iMessage groups already queued), never in any one sender's: group
 * traffic never touches a person's own 1:1 object
 * (docs/decisions/texting-assistant/groups.md).
 *
 * Whether Tex answers a message in a group is the one judge's (`groupTurn.ts`,
 * `textDecide.cjs`; Dev2, 2026-11-11): every message that is not code's (a
 * command said to Tex by name, a settings reply, a style choice) goes to it,
 * whatever the chat's speak-up setting, which the judge reads. Which waiting
 * messages one turn answers, and what a message during a running turn does,
 * are its too (Dev2, 2026-10-26, reversing "two people's texts are two
 * questions"). While the chat is bound, every message is kept until the next
 * turn hands it over as what the chat said (`groupChat.ts`); in a chat Tex is
 * not set up in, nothing is kept: a message waits unlogged for the judge's
 * first look, and is logged only if Tex answers it.
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
 * - `gstyle`, `gengask`: the retired style choice and style question
 *   (2026-11-11), no longer read or written; a chat that has them keeps
 *   a few bytes until its object is cleared.
 * - `gnames` handles by the hash of a phone, never a number (`groupTurn.ts`).
 */

import { GROUP_QUEUE, queueFull, queueItem } from "./chatQueue";
import { ASK_KEY, isAsker, isItForTexInGroup, type OpenAsk } from "./isItForTex";
import { ServiceError, type Fetch } from "./clients";
import { reportRoutineResult, type RoutineOutcome } from "./routineClients";
import { chatRoutineMessage, type ChatRoutineRun } from "./groupRoutines";
import { askControlPlane, type ControlAnswer } from "./groupControl";
import { dropKept, keepAnswer, keptAnswer, refreshKept } from "./groupKept";
import { failedLine, GROUP_LINES, PICTURE_LINE } from "./groupLines";
export { askControlPlane, GROUP_LINES, PICTURE_LINE };
export type { Command, ControlAnswer };
import { log, MAX_SENT, say, timedReply, type ReplyClock } from "./groupSay";
import type { Picture } from "./line";
import type { ImagesLike } from "./attachments";
import type { InboundAttachment } from "./inbound";
import { groupReviewSharing } from "./groupSettings";
import { answers, reactionLine, tapbackText, type Reaction } from "./reactions";
import { ackEmoji } from "./ackEmoji";
import { dropThumb, dueThumb, GROUP_THUMB_KEY, holdsAsAnswer, holdThumb, onMachineAsk, onTexText } from "./thumbs";
import type { InboxStorage } from "./inbox";
import type { SendblueKeys } from "./sendblue";
import type { WhapiKeys } from "./whapi";
import { groupLineFor } from "./groupLine";
import { inRoom, readMembersNow, withKeptMembers } from "./groupMembers";
import type { NoteCardDrawer } from "./noteCards";
import { isBound, isMuted, keepChatLine, peopleOf, setChatBound, sha256Hex, unmute } from "./groupChat";
import type { GroupMessage } from "./sendblueGroups";
import { watchFailed } from "./reviewWatch";
import { callsTex, groupCommand, type Command } from "./groupWords";
import type { JobRun, JobSteer } from "./jobs";
import { armBy, flushChat, pruneEvents, type Conversation } from "./events";
import { rememberChatReader } from "./chatRead";
import { reactionFor } from "./reactEmoji";
import { runningTurn } from "./steer";
import { canWait, chatEvent, readChatState, stillGathering } from "./chatState";
import { chooseGroupTurn, coversOf, keepNames, logGroupInbound, mergedGroup, ownTurn, whileRunning, type GroupEntry, type GroupPending } from "./groupTurn";
import { handedTurnWaits, handOff, TURN_KEY, type HandedTurn } from "./groupTurnRun";
import { answerBesideTurn } from "./groupBeside";
import { groupTurn } from "./groupModelTurn";
import type { TimingDataset } from "./textTiming";

export type GroupDeps = {
  fetch: Fetch;
  /** Where each answered text's wait is written (`textTiming.ts`); absent, nowhere. */
  textTiming?: TimingDataset;
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
  /** Present, a chosen turn is answered here at once and its workflow only retries a failure (`groupTurnRun.ts`); keeps that answer alive. */
  answerFirst?: (work: Promise<unknown>) => void;
};

/** A group's queue is named apart from every phone's, which always starts with "+". */
export function groupInboxName(groupId: string): string {
  return `sendblue-group:${groupId}`;
}

type Pending = GroupPending;

const SEEN_FOR_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = GROUP_QUEUE.max;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 20_000;
const seenKey = (eventId: string, words: string) => `gseen:${eventId}:${words}`;
/** The same person tagging Tex with the same words this soon after is the same ask. */
export const SAME_ASK_MS = 10 * 60_000;
const RECENT_KEY = "grecent";
type Recent = { h: string; at: number };
/** A picture from the person whose tag is still waiting joins that tag, this soon after it. */
export const PICTURE_JOINS_MS = 2 * 60_000;
/** The newest pictures and files a turn reads, its own and the chat's since Tex last answered. */
export const MAX_GROUP_FILES = 4;


export { groupCommand, peopleOf };
export { ASK_KEY, type OpenAsk };

/**
 * Accept a group message. Code's (a style choice, a settings reply, a command said to Tex by name): it waits for the
 * alarm. Anything else is the judge's: in a bound chat it is kept as what the chat said and waits for the judge; in a
 * chat Tex is not set up in (or from an SMS), it waits unlogged for the judge's first look. While a turn runs here,
 * a message is judged with the turn running (`groupTurn.ts`).
 */
export async function acceptGroup(storage: InboxStorage, message: GroupMessage, now: number): Promise<"queued" | "kept" | "ignored" | "duplicate" | "full"> {
  // Every reaction is input (Dev2, 2026-11-01): a held ask's yes is code's; any other reads on as its line of the chat.
  if (message.reaction !== undefined) {
    const read = await acceptReaction(storage, message, message.reaction, now);
    if (read.kind === "done") return read.outcome;
    message = { ...message, text: read.line };
  }
  // WhatsApp names only the sender: the group's kept list says who else heard it (`groupMembers.ts`).
  message = await withKeptMembers(storage, message);
  const { repliesToTex, forTex: tagged, byCode } = await isItForTexInGroup(storage, message, now);
  const seen = seenKey(message.eventId, await sha256Hex(message.text));
  if ((await storage.get<number>(seen)) !== undefined) return tagged ? "duplicate" : "ignored";
  // A chat Tex is not set up in keeps nothing it is told, nor does an SMS (its sender vouches for nothing). Fail closed
  // (security review, 2026-11-11): only a message that tags or names Tex, or replies under its text, is read at all,
  // and then by the judge alone, on its own words, logged only if answered (`firstLook`). A muted chat, and a reaction
  // there, is never read: only a command said to Tex by name ("Tex, start") reaches it.
  if (!tagged && (message.sms === true || !(await isBound(storage, message)))) {
    const calls = message.reaction === undefined && !(await isMuted(storage)) && callsTex(message.heard ?? message.text, repliesToTex);
    if (!calls) return log("untagged_ignored", "unbound"), "ignored";
    log("untagged_first_look");
    return await enqueue(storage, message, { soft: true, look: true }, repliesToTex, seen, now);
  }
  const running = runningTurn(storage, message.groupId);
  // Not code's, in a bound chat: kept as what the chat said, and the judge's. `ev` given: it was logged already.
  const idleUntagged = async (logged?: string): Promise<"kept" | "ignored"> => {
    // Right after the sender's own waiting message, it goes with it.
    const follows = await followsOwnTag(storage, message, now);
    if (!(await keepChatLine(storage, message, now))) return log("untagged_ignored", "unbound"), "ignored";
    await storage.put(seen, now);
    const ev = logged ?? (await logGroupInbound(storage, message, now));
    await enqueue(storage, message, { ev, soft: true, ...(follows ? { joins: true as const } : {}) }, repliesToTex, seen, now);
    log("untagged_to_decide");
    return "kept";
  };
  if (!tagged && running === undefined) return await idleUntagged();
  // Nothing of an SMS group is logged: its sender vouches for nothing.
  const ev = message.sms ? undefined : await logGroupInbound(storage, message, now);
  const extra: Partial<Pending> = { ...(ev ? { ev } : {}), ...(byCode ? { byCode: true as const } : {}) };

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
  // Code's to answer, every time: "Tex, stop" said again is answered again (Dev2, 2026-10-29).
  return await enqueue(storage, message, extra, repliesToTex, seen, now);
}

async function enqueue(storage: InboxStorage, message: GroupMessage, extra: Partial<Pending>, repliesToTex: boolean, seen: string, now: number): Promise<"queued" | "full"> {
  if (await queueFull(storage, GROUP_QUEUE)) return "full";
  await storage.put(seen, now);
  // Whether it replies to Tex is decided now, against the handles Tex sent; the turn reads the words it quotes.
  // A reaction goes on as its line alone: only a held one (`holdThumb`) reaches the gateway as a tapback, which can be a yes.
  // Its answer never threads under the tapback itself, which Sendblue fails to deliver (`answersTapback`).
  const tapback = message.reaction !== undefined ? { answersTapback: repliesToTex && message.replyTo !== undefined ? { on: message.replyTo } : {} } : {};
  await queueItem<Pending>(storage, GROUP_QUEUE, { message: { ...message, reaction: undefined, ...(repliesToTex ? {} : { replyTo: undefined }), ...tapback }, attempts: 0, at: now, ...extra });
  // The chat moved (a wait that began before this decides again: `stillGathering`), and the burst Tex owes an answer to
  // starts with its first waiting message: its deadline counts from here. A line kept only as chat changes neither.
  if (!extra.byCode) await chatEvent(storage, "message", "queued", { now, burst: true }); // a command is no part of a burst
  // Answered at once (no wait for a picture since 2026-10-31): a picture that follows mid-turn is taken in (`steer.ts`),
  // and a burst still being typed is decide's to hold (`chatState.ts`).
  await storage.setAlarm(now);
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
  if (await queueFull(storage, GROUP_QUEUE)) return "full";
  await queueItem<Pending>(storage, GROUP_QUEUE, { message, attempts: 0, at: now, byCode: true });
  await storage.put(seen, now);
  await storage.setAlarm(now);
  return "queued";
}

/** How a chat routine's run went, to the control plane: a code, never its words. */
export async function routineDone(deps: GroupDeps, message: GroupMessage, outcome: RoutineOutcome, texted = 0): Promise<void> {
  if (message.routine === undefined) return;
  log(`routine_${outcome}`);
  if (message.jobReport !== undefined || message.event === "vault_saved") return; // a job's report and a saved login's turn run as a routine's turn does, but no run waits on them
  await reportRoutineResult(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, { runId: message.routine.runId, outcome, texted }).catch(() => log("routine_unreported"));
}

/**
 * Anything sent by someone whose tag is still waiting, a moment after it,
 * goes to decide with it whatever the style, so one turn can read both: the
 * screenshot after "Tex, file this screenshot as a bug report" (Dev2,
 * 2026-10-23, Tex answered that it couldn't see one), the link after "Tex
 * check this link out". Only their own tag, and only one sent a moment ago.
 */
async function followsOwnTag(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  // An SMS joins nothing: its sender can be faked.
  if (message.sms) return false;
  const pending = [...(await storage.list<Pending>({ prefix: GROUP_QUEUE.prefix })).values()];
  return pending.some((item) => item.message.from === message.from && item.attempts === 0 && !item.soft && now - (item.at ?? 0) < PICTURE_JOINS_MS);
}

/** The pictures and files a turn reads: the newest of its own and of what the chat sent since Tex last answered, oldest first. */
export function filesFor(message: GroupMessage, lines: readonly { attachments?: InboundAttachment[] }[]): InboundAttachment[] {
  const all = [...lines.flatMap((line) => line.attachments ?? []), ...(message.attachments ?? [])];
  return all.slice(-MAX_GROUP_FILES);
}

type ReactionRead = { kind: "done"; outcome: "queued" | "ignored" } | { kind: "line"; line: string };

/**
 * A reaction in a group (Dev2, 2026-11-01: every tapback and emoji is input).
 * - Taken back: logged; drops a held yes only when it was the asker's.
 * - A 👍, ❤️ or 👎 from the asker on the ask: code's, held as their answer (`thumbs.ts`); nobody else's ever is,
 *   and the gateway takes no yes from a guest (`guestTagger`), so neither ever releases what was held. On an ask to
 *   run a job on a lent computer anyone's is held, and the gateway takes only its owner's (`onMachineAsk`).
 * - On a text of Tex's that asks something (or any ❓ on Tex's): that person's answer, read as its line
 *   ("👍 (yes) on Tex's message …"), which the judge is taught to answer.
 * - Anything else: a line of the chat, for the judge like any message.
 */
async function acceptReaction(storage: InboxStorage, message: GroupMessage, reaction: Reaction, now: number): Promise<ReactionRead> {
  const onTex = await onTexText(storage, message.groupId, reaction);
  const line = reactionLine(reaction, onTex);
  const asker = await isAsker(storage, message, now);
  if (reaction.removed) {
    if (asker) await dropThumb(storage, reaction.words, GROUP_THUMB_KEY);
    await logGroupInbound(storage, { ...message, text: line }, now);
    log("reaction_removed");
    return { kind: "done", outcome: "ignored" };
  }
  // The ask's own words are checked by `holdsAsAnswer`, and again by the gateway against what is held. An ask to run
  // a job on someone's computer waits on its owner, not the asker: anyone's goes, and the gateway takes only the owner's.
  if ((asker || (onTex && onMachineAsk(reaction))) && holdsAsAnswer(reaction)) {
    await logGroupInbound(storage, { ...message, text: line }, now);
    await holdThumb<GroupMessage>(storage, { ...message, text: tapbackText(reaction.how) }, reaction.words, now, GROUP_THUMB_KEY);
    log("reaction_ask");
    return { kind: "done", outcome: "queued" };
  }
  // Somebody else's on the ask that is held for the asker is a line of the chat, never an answer.
  const answersTex = onTex && answers(reaction) && !holdsAsAnswer(reaction);
  log(answersTex ? "reaction_answer" : "reaction_context");
  return { kind: "line", line };
}

/**
 * What the judge chose to answer, less an ask this person already had
 * answered in these same words a moment ago (Dev2, 2026-10-21: the same bug
 * report sent twice was written up twice), which is dropped. Only an ask of
 * some length: a short "yes" or "send it" answers each new question afresh.
 */
async function notAskedAgain(storage: InboxStorage, entries: GroupEntry[], now: number): Promise<GroupEntry[]> {
  const fresh: GroupEntry[] = [];
  for (const entry of entries) {
    // lean: a length floor, not a word rule; an exact repeat of a short reply is a new answer to a new question.
    // Every answered ask is remembered; a forced or rechecked one is answered again on purpose (`recheckDraft`, a restart), never dropped.
    const repeat = entry[1].message.text.trim().length >= REPEAT_CHARS && (await askedJustNow(storage, entry[1].message, entry[1].at ?? now));
    if (repeat && entry[1].force !== true && entry[1].rechecked !== true) {
      log("duplicate_ask");
      await storage.delete(entry[0]);
    } else fresh.push(entry);
  }
  return fresh;
}

/** The shortest ask `notAskedAgain` treats as a repeat. */
const REPEAT_CHARS = 16;

/**
 * Whether this person asked Tex with these same words a moment ago. Kept as
 * hashes of sender and words, never either. Remembers this ask either way.
 */
async function askedJustNow(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  const h = await sha256Hex(`${message.from}\n${message.text.replace(/\s+/g, " ").trim().toLowerCase()}`);
  const recent = ((await storage.get<Recent[]>(RECENT_KEY)) ?? []).filter((item) => now - item.at < SAME_ASK_MS);
  const again = recent.some((item) => item.h === h);
  await storage.put<Recent[]>(RECENT_KEY, [...recent.filter((item) => item.h !== h), { h, at: now }].slice(-MAX_SENT));
  return again;
}


/** Answer what is waiting, oldest first: code's messages one by one, the rest as decide groups them. Called from the alarm. */
export async function drainGroup(storage: InboxStorage, deps: GroupDeps): Promise<void> {
  try {
    await drainOnce(storage, deps);
  } finally {
    // One alarm per object: whatever set a sooner one, the events' day is kept.
    await pruneEvents(storage, deps.now());
  }
}

async function drainOnce(storage: InboxStorage, deps: GroupDeps): Promise<void> {
  // A 👍 on the ask joins the queue as the asker's answer.
  const thumb = await dueThumb<GroupMessage>(storage, deps.now(), GROUP_THUMB_KEY);
  if (thumb !== undefined) await queueItem<Pending>(storage, GROUP_QUEUE, { message: thumb, attempts: 0, at: deps.now(), byCode: true });
  for (let pass = 0; pass < 3 * MAX_PENDING; pass += 1) {
    // One model turn at a time: while a workflow answers one, the rest wait for it (`groupTurnRun.ts`); a fixed line goes now (`groupBeside.ts`).
    if (deps.startTurn !== undefined && (await handedTurnWaits(storage, deps))) {
      return void (await answerBesideTurn(storage, deps, (await storage.get<HandedTurn>(TURN_KEY))?.keys ?? []));
    }
    const pending = [...(await storage.list<Pending>({ prefix: GROUP_QUEUE.prefix }))];
    if (pending.length === 0) break;
    let entries: GroupEntry[] = [pending[0]];
    if (!pending[0][1].byCode && pending[0][1].attempts === 0) {
      const burst: GroupEntry[] = [];
      for (const entry of pending) {
        if (entry[1].byCode) break;
        burst.push(entry);
      }
      // Decide said wait and nothing came since: still held (an addressed message never waits). A new message decides again now.
      const state = await readChatState(storage);
      const untagged = burst.every(([, item]) => item.soft === true && item.force !== true);
      if (untagged && stillGathering(state, deps.now())) {
        await armBy(storage, state.until!, deps.now());
        // What code answers alone (a command, a menu reply) never waits on a held burst (`groupBeside.ts`).
        return void (await answerBesideTurn(storage, deps, burst.map(([key]) => key)));
      }
      const choice = await chooseGroupTurn(storage, deps, burst, untagged && canWait(state, deps.now()));
      // Decide's reaction goes at once, whatever it decided about words, and only once per message.
      if (choice.react) {
        const [key, item] = choice.react;
        await groupLineFor(deps, item.message.groupId).react({ line: item.message.line, groupId: item.message.groupId }, item.message.messageId, reactionFor(choice.emoji, ackEmoji(item.message.text)));
        await storage.put<Pending>(key, { ...item, reacted: true });
        for (const list of [choice.answer, choice.wait ?? []]) for (const entry of list) if (entry[0] === key) entry[1] = { ...entry[1], reacted: true };
      }
      if (choice.wait !== undefined && choice.wait.length > 0) {
        const held = await chatEvent(storage, "wait", "decide", { now: deps.now(), seconds: choice.waitSeconds });
        if (held.ok) {
          await armBy(storage, held.state.until!, deps.now());
          log("waiting");
          return void (await answerBesideTurn(storage, deps, choice.wait.map(([key]) => key)));
        }
        // Past the burst's deadline or its waits: answered now, never held again.
        choice.answer = choice.wait;
      }
      // Left as chat: an untagged one is already one of the chat's lines (`acceptGroup`); an addressed one becomes one.
      for (const [key, item] of choice.chat) {
        if (!item.soft) await keepChatLine(storage, item.message, item.at ?? deps.now());
        await storage.delete(key);
      }
      for (const [key] of choice.drop) await storage.delete(key);
      entries = await notAskedAgain(storage, ownTurn(choice.answer), deps.now());
      if (entries.length === 0) {
        await chatEvent(storage, "silent", choice.react ? "react" : "decide", { now: deps.now() });
        continue;
      }
    }
    // A retried turn (the inline path) is still the same draft: only a first attempt starts one.
    if (entries.at(-1)![1].attempts === 0) await chatEvent(storage, "start", entries.at(-1)![1].byCode ? "code" : "turn", { now: deps.now() });
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
    await chatEvent(storage, outcome === "cancelled" ? "cancelled" : "done", "inline", { now: deps.now() });
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
    await chatEvent(storage, "failed", "inline", { now: deps.now() });
    await turnFailed(storage, deps, item.message, error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : undefined);
  }
  return false;
}

/**
 * A routine's turn the chat can't run now. A scheduled routine or check-in is nobody asking just now, so it passes
 * quietly. A job's report answers someone who asked, so the chat hears there is news, never silence (the owner,
 * 2026-11-12: the Nov Babies chat's two finished pages were dropped here), unless Tex was told to stop in this chat.
 */
async function cannotRun(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, status: string | null): Promise<void> {
  if (message.jobReport === undefined || status === "muted" || status === "stopped") return await routineDone(deps, message, "no_chat");
  log("job_report_held");
  await say(storage, deps, message, GROUP_LINES.jobReportRefused, { system: true, reason: "failed" }).catch(() => {});
}

/** A turn given up on (`reason` as logged): a routine nobody asked for just now fails quietly; anyone else is told what broke, and the chat is scored (`watchFailed`). */
export async function turnFailed(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, reason: string | undefined): Promise<void> {
  if (message.jobReport !== undefined) {
    // Never lost in silence: the chat hears that news is waiting, and the job list holds it for the next tag (`chatJobs`).
    log("job_report_failed");
    await say(storage, deps, message, GROUP_LINES.jobReportRefused, { system: true, reason: "failed" }).catch(() => {});
  } else if (message.routine !== undefined) await routineDone(deps, message, "failed");
  else await say(storage, deps, message, failedLine(reason), { system: true, reason: reason === "gateway:504" ? "timed_out" : "failed" }).catch(() => {}).then(() => watchFailed(storage, deps, message));
}

/** One turn for `entries`, as one message (`mergedGroup`). "cancelled" when a restart cancelled it: nothing of it was sent. */
export async function answerGroup(storage: InboxStorage, entries: GroupEntry[], deps: GroupDeps, clock?: ReplyClock): Promise<"cancelled" | void> {
  const item = entries.at(-1)![1];
  let message = mergedGroup(entries.map(([, entry]) => entry.message));
  // What the chat said before the first message it answers is its context; the rest it answers.
  const acceptedAt = entries[0][1].at ?? deps.now();
  const covers = coversOf(entries);
  const app = groupLineFor(deps, message.groupId);
  // A green-bubble group is never answered from anyone's notes: SMS vouches for no sender.
  if (message.sms) return void (await say(storage, deps, message, GROUP_LINES.sms, { system: true }));
  const chat = { line: message.line, groupId: message.groupId };
  const routine = message.routine !== undefined;
  const command = routine ? null : groupCommand(message.text);
  // The app's own list too: more people only ever narrows what Tex may use. Unread where the webhook names only the sender, it's retried (`groupLine.ts`).
  // Unread on Sendblue, a question is retried too (2026-11-02): its webhook may name someone by an email handle the answer's read
  // then lists as a phone, a newcomer nobody was, and the control plane mints the turn's grant and spends the one-shot intro on
  // the people it is given. A command is answered from the webhook's names, so "Tex, stop" works with the groups API down;
  // "what can you see" waits, since it names the workspaces those people share.
  const members = await readMembersNow(storage, app, chat, deps.now); // kept, for the check before sending (`groupMembers.ts`)
  clock?.mark("members");
  if (members === null) log("members_unread");
  // WhatsApp's webhook named only the sender: the chat is bound, read and filed by the list just read (`inRoom`).
  if (app.senderOnlyWebhook && members !== null) message = inRoom(message, members);
  const question = command === null;
  if (members === null && !routine && (app.senderOnlyWebhook || question || command?.kind === "status")) throw new ServiceError(app.senderOnlyWebhook ? "whapi" : "sendblue", null);
  // A routine runs as its writer's tag only while Sendblue says they are in the chat: nothing else lists who is.
  // A job's report waits for the members it could not read, as a question does, rather than being dropped unread.
  if (routine && members === null && message.jobReport !== undefined) throw new ServiceError(app.senderOnlyWebhook ? "whapi" : "sendblue", null);
  if (routine && (members === null || !members.includes(message.from))) return void (await cannotRun(storage, deps, message, null));
  const people = peopleOf(message.line, message.participants, members);
  // A plain tag from the same person, with the same people, reuses the last token and asks the control plane behind the turn (`groupKept.ts`).
  const plain = command === null && !routine && members !== null;
  const kept = plain ? await keptAnswer(storage, message.line, message.from, people, deps.now()) : null;
  if (!plain) await dropKept(storage);
  const asked = kept ?? (await askControlPlane(deps, message, people, command));
  if (kept === null && plain) await keepAnswer(storage, message.line, message.from, people, asked, deps.now());
  const behind = kept === null ? null : () => askControlPlane(deps, message, people, null, { mint: false }).then((answer) => refreshKept(storage, answer), () => refreshKept(storage, null));
  clock?.mark("control"); // near zero when kept
  const status = asked.status;
  const fixed = (text: string) => say(storage, deps, message, text, { system: true });
  // A chat that can't run it now is told nothing: nobody in it asked just now.
  if (routine && status !== "ready") return void (await cannotRun(storage, deps, message, status));
  // A chat that isn't answering keeps nothing it was told.
  if (status === "muted" || status === "stopped" || status === "no_shared") await setChatBound(storage, null, status !== "no_shared");
  if (status === "refused" || status === "muted") return log(status);
  if (status === "unknown_sender") return asked.tell === true ? void (await fixed(GROUP_LINES.unknown)) : log(status);
  if (status === "no_shared") return void (await fixed(GROUP_LINES.noShared));
  if (status === "not_allowed") {
    return void (await fixed(command?.kind === "invite" ? GROUP_LINES.notOwner(asked.slug) : GROUP_LINES.notAllowed(asked.slug)));
  }
  if (status === "invited") {
    await setChatBound(storage, message);
    return void (await fixed(GROUP_LINES.invited(asked.slug, asked.count, asked.role)));
  }
  if (status === "mail_shared") return void (await fixed(GROUP_LINES.mailShared(asked.address, asked.narrowed)));
  if (status === "mail_unshared") return void (await fixed(GROUP_LINES.mailUnshared(asked.count)));
  if (status === "mail_refused") return void (await fixed(GROUP_LINES.mailRefused));
  if (status === "stopped") return void (await fixed(GROUP_LINES.stopped));
  if (status === "started") return await unmute(storage), void (await fixed(GROUP_LINES.started));
  if (status !== "ready") throw new ServiceError("control_plane", null);
  // A routine's run carries no webhook people list (`chatRoutineMessage`): binding to it would bind the chat to nobody,
  // and every untagged text after it would be dropped as said in front of other people.
  if (!routine) {
    await setChatBound(storage, message);
  }
  await keepNames(storage, asked.names ?? []);
  if (command?.kind === "status") return clock?.path("status"), void (await fixed(GROUP_LINES.status(asked.reach ?? [asked.slug])));
  // "Tex, share my chats with the devs" (`groupSettings.ts`).
  if (command?.kind === "review_sharing") return clock?.path(command.kind), await groupReviewSharing(storage, deps, message, command.sharing);
  if (asked.accessToken === undefined) throw new ServiceError("control_plane", null);
  // The chat's events reach its log before the turn reads it, written with the chat's own grant.
  const conversation: Conversation = { group: message.groupId };
  rememberChatReader(storage, message.groupId, { token: asked.accessToken, conversation, fetch: deps.fetch, gatewayOrigin: deps.gatewayOrigin }); // the next read of this chat asks the ledger (`chatRead.ts`)
  await flushChat(storage, deps, asked.accessToken, conversation, message.groupId, () => sha256Hex(message.from));
  // The introduction is one-shot (the control plane marks it given): it rides at the end of this turn's answer (`groupModelTurn.ts`).
  const covered = entries.map(([, entry]) => entry.message);
  const contextUntil = Math.max(acceptedAt, item.contextUntil ?? acceptedAt);
  const upTo = Math.max(acceptedAt, ...entries.map(([, entry]) => entry.at ?? 0));
  // Addressed: decide is asked now, beside the turn, and its verdict is waited on only before anything is sent.
  // A turn that fails on a kept token (the gateway refused it, say) drops it, so its retry asks the control plane first.
  const outcome = await groupTurn(storage, deps, { message, covered, acceptedAt: contextUntil, upTo, arrivedAt: acceptedAt, covers, people, asked, accessToken: asked.accessToken }).catch(async (error: unknown) => {
    if (kept !== null) await dropKept(storage);
    throw error;
  });
  await flushChat(storage, deps, asked.accessToken, conversation, message.groupId, () => sha256Hex(message.from));
  await behind?.();
  return outcome;
}

async function pruneSeen(storage: InboxStorage, now: number): Promise<void> {
  const seen = await storage.list<number>({ prefix: "gseen:" });
  for (const [key, at] of seen) if (now - at > SEEN_FOR_MS) await storage.delete(key);
}
