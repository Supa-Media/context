/**
 * Which of a group's waiting messages one turn answers, and whether any is
 * answered at all: the one judge's (Clef, `decide.ts`, `textDecide.cjs`;
 * Dev2, 2026-11-11, one judge; 2026-10-26, reversing "two people's texts are
 * two questions"). Every message that is not code's reaches it, whatever the
 * speak-up setting, which it reads; no word rule says what is for Tex. A
 * message from a chat Tex is not set up in is judged alone, unlogged
 * (`firstLook`). The judge down, a group answers a waiting question or a
 * message calling Tex (`judgeDownAnswer`). Kept as code: only the asker's yes releases what was
 * held, a style choice and the commands are never put to the judge, and a
 * newcomer's transcript starts where they joined (`renderTranscript` with
 * `people`).
 */

import { gatherTheTurn } from "./gatherTheTurn";
import { noteHandle, replyFields } from "./replyQuote";
import { chatEvent } from "./chatState";
import { MAX_INBOUND_ATTACHMENTS } from "./inbound";
import { addEvent, kindOf, markStale, renderTranscript, waitingAsks, type TexEvent } from "./events";
import { chatEvents } from "./chatRead";
import { decide, GROUP_DECIDE_MS, MAX_CANDIDATES, RUNNING_DECIDE_MS, type ControlDeps, type Decision, type GroupStyle } from "./decide";
import { eventPeople, sha256Hex } from "./groupChat";
import { restartTurn, steerInto, type Live } from "./steer";
import { PICTURE_LINE } from "./groupLines";
import { burstStillTyped, decideDownAnswer } from "./groupPolicy";
import { callsTex } from "./groupWords";
import { groupStyle } from "./groupStyle";
import type { GroupMessage } from "./sendblueGroups";
import type { InboxStorage } from "./inbox";

/**
 * `at`: when it was accepted, so its turn is handed only what the chat said
 * before it. `ev` its event id. `soft`: the judge's to answer or not; left
 * unanswered it becomes a chat line. `force`: answered by the next turn
 * whatever the judge says. `byCode`: never put to the judge (a command, a
 * thumb). `look`: from a
 * chat Tex is not set up in (or an SMS), unlogged until the judge answers it.
 */
export type GroupPending = {
  message: GroupMessage;
  attempts: number;
  at?: number;
  ev?: string;
  soft?: true;
  force?: true;
  byCode?: true;
  /** On a turn kept for a retry: the events it answers besides its own. */
  covers?: string[];
  /** What the chat said up to here is the turn's context (somebody else's lines decide covered with it). */
  contextUntil?: number;
  /** Sent by the tagger a moment after their own waiting tag (`followsOwnTag`): it goes with that tag. */
  joins?: true;
  /** Tex already reacted to it (decide's emoji, `chatState.ts`): the turn that answers it adds no second tapback. */
  reacted?: true;
  /** A turn's draft for it was held by `recheckDraft` once already: the next answer is sent. */
  rechecked?: true;
  /** Waiting on the judge's first look: nothing of it is kept or logged unless the judge answers it (`firstLook`). */
  look?: true;
};
export type GroupEntry = [string, GroupPending];

/** Handles by the hash of a phone, as the control plane last named them, never a number: so events can say who spoke. */
const NAMES_KEY = "gnames";

export async function keepNames(storage: InboxStorage, names: readonly { phone: string; handle: string }[]): Promise<void> {
  const kept: Record<string, string> = {};
  for (const { phone, handle } of names.slice(0, 64)) kept[await sha256Hex(phone)] = handle;
  await storage.put(NAMES_KEY, kept);
}

/** The event for one group message in: who as a hash and a handle when known, who was there as a hash. */
export async function logGroupInbound(storage: InboxStorage, message: GroupMessage, now: number): Promise<string> {
  const who = await sha256Hex(message.from);
  const name = ((await storage.get<Record<string, string>>(NAMES_KEY)) ?? {})[who];
  const id = await addEvent(storage, {
    at: now,
    chat: message.groupId,
    from: { kind: "person", who, ...(name ? { name } : {}) },
    kind: message.reaction ? "reaction" : kindOf(message.text, message.attachments),
    // A voice message's words, as heard before the judge reads it (`groupVoice.ts`): the judge cannot hear the recording.
    text: message.text.trim() === "" && message.heard ? `(voice message) ${message.heard}` : message.text,
    ...(message.left && !message.reaction ? { left: message.left } : {}),
    people: await eventPeople(storage, message),
    // A reply under an earlier message, found by the handle the webhook names: its id and full words (`replyQuote.ts`).
    ...(message.reaction || message.replyTo === undefined ? {} : await replyFields(storage, message.groupId, { handle: message.replyTo })),
  });
  if (!message.reaction) await noteHandle(storage, message.messageId, id);
  return id;
}

/**
 * Ask the judge about the newest of `candidates`. `look`: a chat Tex is not set up in, judged on these lines alone
 * (`firstLook`), with no ledger to keep its verdict; otherwise the chat's log from its ledger, and the verdict kept
 * there as a `judge` entry (the gateway writes it, `textsDecide.js`).
 */
async function ask(storage: InboxStorage, deps: ControlDeps & { now: () => number }, newest: GroupMessage, candidates: string[], running: boolean, look?: string): Promise<Decision> {
  const style = (await groupStyle()).style;
  const decision = await decide(
    deps,
    {
      chat: newest.groupId,
      line: newest.line,
      sender: newest.from,
      style,
      // The chat's whole log, whoever has joined or left since (the owner, 2026-11-02).
      transcript: look ?? renderTranscript(await chatEvents(storage, newest.groupId)),
      candidates,
      running,
      // Only the sender's own asks: nobody else's "nah forget it" can end somebody's ask.
      waitingAsks: look !== undefined ? [] : await waitingAsks(storage, deps.now(), await sha256Hex(newest.from)),
      newest: candidates.at(-1) ?? "",
      // The chat's ledger, where the verdict is kept: the control plane's key for it (`groupKeyOf`), never for a first look.
      ...(look !== undefined ? {} : { ledger: await sha256Hex(`${newest.line}:${newest.groupId}`) }),
    },
    running ? RUNNING_DECIDE_MS : GROUP_DECIDE_MS,
  );
  // Codes only: the act and its why, or why the judge could not answer.
  console.log(
    JSON.stringify({
      event: "group_decide",
      outcome: decision.ok ? decision.act : decision.reason,
      ...(decision.ok && decision.why ? { why: decision.why } : {}),
      ...(!decision.ok && decision.cause ? { reason: decision.cause } : {}),
      ...(decision.ms !== undefined ? { ms: decision.ms } : {}),
      ...(running ? { kind: "running" } : look !== undefined ? { kind: "first_look" } : {}),
    }),
  );
  if (decision.ok) {
    await markStale(storage, decision.stale);
  }
  return decision;
}

/**
 * `react`/`emoji`: a reaction on the newest message in place of an answer (decide's `react`; Dev2, 2026-11-10: a
 * tapback only instead of words, never beside them; `reactionFor` checks the emoji). `wait`: untagged messages held for the rest of
 * the burst, `waitSeconds` as decide chose; the chat's state caps it (`chatState.ts`).
 */
export type GroupChoice = { answer: GroupEntry[]; chat: GroupEntry[]; drop: GroupEntry[]; react?: GroupEntry; emoji?: string; wait?: GroupEntry[]; waitSeconds?: number };

// The reply rules live in `groupPolicy.ts`; this stays importable from here.
export { looksUnfinished } from "./groupPolicy";

const soft = (entry: GroupEntry) => entry[1].soft === true && entry[1].force !== true;

/**
 * An addressed message and what its sender sent right after it to go with it
 * (`joins`: the picture or link after "Tex check this", `followsOwnTag`):
 * read as one, whatever decide says, as `joinsWaitingTag` did before decide.
 */
function withJoins(burst: GroupEntry[], head: GroupEntry): GroupEntry[] {
  const own = burst.slice(burst.indexOf(head) + 1).filter((entry) => entry[1].message.from === head[1].message.from);
  const stop = own.findIndex((entry) => entry[1].joins !== true);
  return [head, ...(stop === -1 ? own : own.slice(0, stop))];
}

/**
 * What the next turn answers out of `burst` (waiting messages, none code's,
 * oldest first), as the judge chooses: whether they are answered, and which
 * of them an answer covers. A message the judge already chose to answer
 * (`force`) is answered with what joined it (`addressedTurn`). Messages from a
 * chat Tex is not set up in are judged first, alone (`firstLook`). The judge
 * down: a waiting question, or a message calling Tex, is answered (`judgeDownAnswer`), so a follow-up is
 * never dropped silently; the rest become chat lines.
 */
export async function chooseGroupTurn(storage: InboxStorage, deps: ControlDeps & { now: () => number }, burst: GroupEntry[], waitAllowed = false): Promise<GroupChoice> {
  const forced = addressedTurn(burst);
  if (forced !== null) return forced;
  const looks = burst.filter(([, item]) => item.look === true);
  if (looks.length > 0) return await firstLook(storage, deps, looks);
  const ids = burst.flatMap(([, item]) => (item.ev ? [item.ev] : []));
  if (ids.length === 0) console.log(JSON.stringify({ event: "group_decide", outcome: "unavailable", reason: "no_events" }));
  const decision = ids.length === 0 ? ({ ok: false, reason: "unavailable" } as const) : await ask(storage, deps, burst.at(-1)![1].message, ids, false);
  if (!decision.ok) {
    const question = judgeDownAnswer(burst);
    return question === -1 ? { answer: [], chat: burst, drop: [] } : { answer: [burst[question]], chat: burst.filter((_, index) => index !== question), drop: [] };
  }
  // A wait holds only a real burst, and only while the chat's state allows one more (`canWait`): otherwise an answer.
  const act = decision.act === "wait" && !(waitAllowed && burstStillTyped(burst.map(([, item]) => item))) ? "answer" : decision.act;
  const newest = burst.at(-1)!;
  // A tapback only in place of words, never beside an answer or a wait (Dev2, 2026-11-10: "uses emojis way too much").
  const react = act === "react" && !newest[1].reacted ? { react: newest, ...(decision.emoji ? { emoji: decision.emoji } : {}) } : {};
  if (act === "wait") return { answer: [], chat: [], drop: [], wait: burst, waitSeconds: decision.waitSeconds ?? 1, ...react };
  if (act !== "answer") return { answer: [], chat: burst, drop: [], ...react };
  // Left out before the answer: chat (`gatherTheTurn.ts`). Nothing here is forced (`addressedTurn` took those), so nothing jumps the order.
  const { answer, left } = gatherTheTurn(burst, (entry) => entry[1].ev !== undefined && decision.covers.includes(entry[1].ev), (entry) => !soft(entry));
  return { answer, chat: left, drop: [], ...react };
}

/**
 * The judge down (past its time, failed, or capped): the newest waiting question, or the newest message that tags or
 * names Tex or replies under its text (`callsTex`), whichever came later; -1 for neither (Dev2, 2026-11-11: "@Tex"
 * must still work when the judge cannot answer). A muted chat never gets here: only its commands are read, by code.
 */
export function judgeDownAnswer(waiting: GroupEntry[]): number {
  const called = waiting.map(([, item]) => callsTex(item.message.text || item.message.heard || "", item.message.replyTo !== undefined)).lastIndexOf(true);
  return Math.max(decideDownAnswer(waiting.map(([, item]) => item)), called);
}

/** The id a first look shows a line under: the contract's event id shape, never one the chat's log holds. */
const lookId = (at: number, index: number): string => `${String(at).padStart(13, "0")}-${String(900_000 + index).padStart(6, "0")}`;

/**
 * Messages from a chat Tex is not set up in, or SMS (`look`), judged on their own words alone: nothing of the chat is
 * kept, so the judge reads only these, and its verdict is kept nowhere. What it answers is logged now, as any message
 * Tex answers is (an SMS never is, and is code's fixed line); the rest is dropped, never kept as chat. The judge down,
 * a waiting question is answered, as in a bound chat.
 */
export async function firstLook(storage: InboxStorage, deps: ControlDeps & { now: () => number }, looks: GroupEntry[]): Promise<GroupChoice> {
  const names = (await storage.get<Record<string, string>>(NAMES_KEY)) ?? {};
  const ids = looks.map(([, item], index) => lookId(item.at ?? deps.now(), index));
  const lines = await Promise.all(
    looks.map(async ([, item], index) => {
      const name = names[await sha256Hex(item.message.from)];
      const event: TexEvent = { id: ids[index]!, at: item.at ?? deps.now(), chat: item.message.groupId, from: { kind: "person", ...(name ? { name } : {}) }, kind: kindOf(item.message.text, item.message.attachments), text: item.message.text || item.message.heard || "" };
      // The day header off; `replyTo` is kept only on a reply under one of Tex's own texts (`enqueue`).
      const line = renderTranscript([event]).split("\n").slice(1).join(" ");
      return item.message.replyTo === undefined ? line : line.replace(/^(<[^>]+> \[[^\]]*\] @[^:]*:)/, "$1 (replying to You)");
    }),
  );
  const decision = await ask(storage, deps, looks.at(-1)![1].message, ids, false, lines.join("\n"));
  let chosen: GroupEntry[];
  if (!decision.ok) {
    const question = judgeDownAnswer(looks);
    chosen = question === -1 ? [] : [looks[question]!];
  } else if (decision.act === "answer") chosen = looks.filter((_, index) => decision.covers.includes(ids[index]!));
  // A first look never waits: nothing is kept to wait with, so a wait answers the newest now.
  else chosen = decision.act === "wait" ? [looks.at(-1)!] : [];
  const answer: GroupEntry[] = [];
  for (const [key, item] of chosen) {
    const { look: _look, ...rest } = item;
    // An SMS is never logged, and code answers it (`answerGroup`'s fixed line); anything else is logged as it is answered.
    const kept: GroupPending = item.message.sms === true ? { ...rest, byCode: true } : { ...rest, force: true, ev: await logGroupInbound(storage, item.message, item.at ?? deps.now()) };
    await storage.put<GroupPending>(key, kept);
    answer.push([key, kept]);
  }
  const newest = looks.at(-1)!;
  const react = decision.ok && decision.act === "react" && !newest[1].reacted ? { react: newest, ...(decision.emoji ? { emoji: decision.emoji } : {}) } : {};
  return { answer, chat: [], drop: looks.filter((entry) => !chosen.includes(entry)), ...react };
}

/**
 * A burst holding a message the judge already chose to answer, or a turn
 * marked to answer it (`force`): answered without asking again, with what its
 * sender sent right after it (`withJoins`). That sender's own waiting lines
 * before it are chat, so the turn reads them; anybody else's, and any after
 * it, stays waiting for the judge on the next pass. Null when nothing is.
 */
export function addressedTurn(burst: GroupEntry[]): GroupChoice | null {
  const first = burst.findIndex((entry) => !soft(entry));
  if (first === -1) return null;
  const answer = [...new Set(burst.filter((entry) => !soft(entry)).flatMap((entry) => withJoins(burst, entry)))];
  const asker = burst[first][1].message.from;
  return { answer, chat: burst.slice(0, first).filter((entry) => entry[1].message.from === asker), drop: [] };
}

/** Several messages as the one a turn answers: words in order, files first-sent first, the newest's sender and place. */
export function mergedGroup(messages: GroupMessage[]): GroupMessage {
  const last = messages.at(-1)!;
  if (messages.length === 1) return last;
  const attachments = messages.flatMap((message) => message.attachments ?? []).slice(0, MAX_INBOUND_ATTACHMENTS);
  return {
    ...last,
    text: messages.map((message) => message.text.trim()).filter(Boolean).join("\n"),
    ...(attachments.length > 0 ? { attachments } : {}),
    replyTo: [...messages].reverse().find((message) => message.replyTo !== undefined)?.replyTo,
  };
}

/** `redecide`: waits, and is decided again once the running turn answered (somebody else's words a fold would have joined to it). */
export type WhileRunning = "folded" | "after" | "redecide" | "chat";

/**
 * A message in a group while a turn runs there: decided with `running: true`.
 * Fold steers its words in; queue and restart answer it after (restart first
 * cancels the turn, and marks what it covered to be answered with this; a
 * cancel the gateway refuses is a queue); silent or react leave it as chat,
 * unless it is addressed to Tex: then it is answered after (code's floor). Decide down: an addressed message waits
 * its turn, anything else is chat, as before.
 */
export async function whileRunning(
  storage: InboxStorage,
  message: GroupMessage,
  ev: string,
  running: Live,
  tagged: boolean,
  now: () => number,
  react: (emoji?: string) => Promise<void>,
): Promise<WhileRunning> {
  const decision = await ask(storage, { ...running.deps, now }, message, [ev], true);
  if (!decision.ok) return tagged ? "after" : "chat";
  const how = decision.midTurn ?? (decision.act === "answer" || decision.act === "wait" ? "queue" : undefined);
  // The running turn runs on its asker's grant: nobody else's message is folded into it or restarts it.
  // Somebody else's is decided again after it (a repeat of the same ask may then need nothing), or answered as their own turn.
  // Never forced into a turn of their own: they get their own decide once the running turn is done (addressed, code's floor answers them).
  if (message.from !== running.asker) {
    if (how === "fold" || how === "restart" || how === "queue" || tagged) return "redecide";
    if (decision.act === "react") await react(decision.emoji);
    return "chat";
  }
  if (how === "fold") {
    if (await steerInto(running, message, message.text.trim() || PICTURE_LINE)) {
      // Taken into the running turn: its answer covers this one too.
      running.covers.push(ev);
      return "folded";
    }
    return tagged ? "after" : "chat";
  }
  if (how === "restart") {
    // At most `MAX_REDRAFTS` per burst (`chatState.ts`): past that the newer words go into the running turn, or after it.
    if (!(await chatEvent(storage, "redraft", "restart", { now: now() })).ok) {
      if (await steerInto(running, message, message.text.trim() || PICTURE_LINE)) return running.covers.push(ev), "folded";
      return "after";
    }
    // The gateway could not stop it: decide wanted this one in a turn, so it waits for the next.
    if (!(await restartTurn(running, message))) return "after";
    for (const [key, item] of await storage.list<GroupPending>({ prefix: "gpending:" })) {
      if (item.ev !== undefined && running.covers.includes(item.ev)) await storage.put<GroupPending>(key, { ...item, force: true });
    }
    return "after";
  }
  // Addressed to Tex: answered after, whatever decide said (code's floor).
  if (how === "queue" || tagged) return "after";
  if (decision.act === "react") await react(decision.emoji);
  return "chat";
}

/**
 * A group turn runs on one person's grant: the control plane resolves it for
 * whoever the message is from. So one turn answers one sender's messages. Of
 * what decide covered, the first message's sender is the asker; somebody
 * else's untagged line is what the chat said around it (it is one of the
 * chat's lines already). Nobody else's message is forced into an answer of
 * its own: each stays waiting, unforced, and the next pass decides it again
 * for its own sender's newest (an addressed one is then answered by code's
 * floor, on their own grant; Dev2's review, 2026-10-27, after a two-person
 * burst got a second answer to a complaint).
 */
export function ownTurn(covered: GroupEntry[]): GroupEntry[] {
  const asker = covered[0]?.[1].message.from;
  const own = covered.filter((entry) => entry[1].message.from === asker);
  // Somebody else's line decide covered is context: the turn reads the chat up to it.
  const until = Math.max(0, ...covered.filter((entry) => entry[1].message.from !== asker && soft(entry)).map((entry) => entry[1].at ?? 0));
  return own.map(([key, item], index) => (index === own.length - 1 ? [key, { ...item, contextUntil: until }] : [key, item]));
}

export const coversOf = (entries: GroupEntry[]): string[] =>
  [...new Set(entries.flatMap(([, item]) => [...(item.covers ?? []), ...(item.ev ? [item.ev] : [])]))].slice(-MAX_CANDIDATES);

