/**
 * Which of a group's waiting messages one turn answers, decided by the
 * control plane (`decide.ts`, the group's style) instead of by hand (Dev2,
 * 2026-10-26, reversing "two people's texts are two questions"). What
 * reaches decide at all is the style's (`groupStyle.ts`); decide unreachable,
 * a group answers what `addressesTex` accepted, one at a time, with what
 * its sender sent right after it (`withJoins`), as before. Addressed, it is
 * answered whatever decide says (`chooseGroupTurn`). Kept as code: only the asker's yes releases what was held, a
 * style choice and the commands are never put to decide, and a newcomer's
 * transcript starts where they joined (`renderTranscript` with `people`).
 */

import { MAX_INBOUND_ATTACHMENTS } from "./inbound";
import { addEvent, keptEvents, kindOf, markStale, renderTranscript, waitingAsks } from "./events";
import { decide, IDLE_DECIDE_MS, MAX_CANDIDATES, RUNNING_DECIDE_MS, type ControlDeps, type Decision, type GroupStyle } from "./decide";
import { eventPeople, sha256Hex } from "./groupChat";
import { restartTurn, steerInto, type Live } from "./steer";
import { PICTURE_LINE } from "./groupLines";
import { groupStyle, movedOn } from "./groupStyle";
import type { GroupMessage } from "./sendblueGroups";
import type { InboxStorage } from "./inbox";

/**
 * `at`: when it was accepted, so its turn is handed only what the chat said
 * before it. `ev` its event id. `soft`: not addressed, put to decide by the
 * style; left unanswered it becomes a chat line. `force`: answered by the
 * next turn whatever decide says. `byCode`: never put to decide (a command,
 * a yes, a style choice, a thumb). `engagement`: the style it chooses.
 */
export type GroupPending = {
  message: GroupMessage;
  attempts: number;
  at?: number;
  ev?: string;
  soft?: true;
  force?: true;
  byCode?: true;
  engagement?: GroupStyle;
  /** On a turn kept for a retry: the events it answers besides its own. */
  covers?: string[];
  /** The message the style question held: never asked about again. */
  styleAsked?: true;
  /** What the chat said up to here is the turn's context (somebody else's lines decide covered with it). */
  contextUntil?: number;
  /** Sent by the tagger a moment after their own waiting tag (`followsOwnTag`): it goes with that tag. */
  joins?: true;
};
export type GroupEntry = [string, GroupPending];
export const groupPendingKey = (seq: number) => `gpending:${String(seq).padStart(12, "0")}`;

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
  return await addEvent(storage, {
    at: now,
    chat: message.groupId,
    from: { kind: "person", who, ...(name ? { name } : {}) },
    kind: message.reaction ? "reaction" : kindOf(message.text, message.attachments),
    text: message.text,
    people: await eventPeople(storage, message),
  });
}

async function ask(storage: InboxStorage, deps: ControlDeps & { now: () => number }, newest: GroupMessage, candidates: string[], running: boolean): Promise<Decision> {
  const style = (await groupStyle(storage)).style;
  const decision = await decide(
    deps,
    {
      chat: newest.groupId,
      line: newest.line,
      sender: newest.from,
      style,
      // Only what was said in front of exactly these people: a newcomer's starts where they joined.
      transcript: renderTranscript(await keptEvents(storage, newest.groupId), { people: await eventPeople(storage, newest) }),
      candidates,
      running,
      // Only the sender's own asks: nobody else's "nah forget it" can end somebody's ask.
      waitingAsks: await waitingAsks(storage, deps.now(), await sha256Hex(newest.from)),
      newest: candidates.at(-1) ?? "",
    },
    running ? RUNNING_DECIDE_MS : IDLE_DECIDE_MS,
  );
  // Codes only: the act, or why decide could not answer.
  console.log(JSON.stringify({ event: "group_decide", outcome: decision.ok ? decision.act : decision.reason, ...(running ? { kind: "running" } : {}) }));
  if (decision.ok) {
    await markStale(storage, decision.stale);
    if (decision.movedOn) await movedOn(storage);
  }
  return decision;
}

export type GroupChoice = { answer: GroupEntry[]; chat: GroupEntry[]; drop: GroupEntry[]; react?: GroupMessage };

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
 * oldest first). A message addressed to Tex (its name, a reply to Tex) is
 * always answered, with what joined it: code's floor, whatever decide says
 * (Dev2's review, 2026-10-27). Decide chooses only whether untagged messages
 * are answered, and which of them an answer covers. Decide down: the oldest
 * addressed one with what joined it; with none, an untagged question that
 * reached decide (its style reads it) is answered, so a follow-up is never
 * dropped silently; other untagged ones become chat lines.
 */
export async function chooseGroupTurn(storage: InboxStorage, deps: ControlDeps & { now: () => number }, burst: GroupEntry[]): Promise<GroupChoice> {
  const ids = burst.flatMap(([, item]) => (item.ev ? [item.ev] : []));
  const decision = ids.length === 0 ? ({ ok: false, reason: "unavailable" } as const) : await ask(storage, deps, burst.at(-1)![1].message, ids, false);
  if (!decision.ok) {
    const first = burst.findIndex((entry) => !soft(entry));
    const question = burst.map((entry) => entry[1].message.text.trim().endsWith("?")).lastIndexOf(true);
    if (first === -1 && question !== -1) return { answer: [burst[question]], chat: burst.filter((_, index) => index !== question), drop: [] };
    return first === -1 ? { answer: [], chat: burst, drop: [] } : { answer: withJoins(burst, burst[first]), chat: burst.slice(0, first), drop: [] };
  }
  const floor = new Set(burst.filter((entry) => !soft(entry)).flatMap((entry) => withJoins(burst, entry)));
  // No tapback on a message about to be answered: its answer gets one of its own (`answerGroup`).
  const react = decision.act === "react" && !floor.has(burst.at(-1)!) ? { react: burst.at(-1)![1].message } : {};
  if (decision.act !== "answer") {
    return { answer: burst.filter((entry) => floor.has(entry)), chat: burst.filter((entry) => !floor.has(entry)), drop: [], ...react };
  }
  const covered = (entry: GroupEntry) => floor.has(entry) || (entry[1].ev !== undefined && decision.covers.includes(entry[1].ev));
  const chosen = burst.filter(covered);
  const answer = chosen.length > 0 ? chosen : [burst.at(-1)!];
  const last = burst.indexOf(answer.at(-1)!);
  // Left out before the answer: chat (every addressed one is in the floor).
  const before = burst.slice(0, last).filter((entry) => !answer.includes(entry));
  return { answer, chat: before.filter(soft), drop: [] };
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
  react: () => Promise<void>,
): Promise<WhileRunning> {
  const decision = await ask(storage, { ...running.deps, now }, message, [ev], true);
  if (!decision.ok) return tagged ? "after" : "chat";
  const how = decision.midTurn ?? (decision.act === "answer" ? "queue" : undefined);
  // The running turn runs on its asker's grant: nobody else's message is folded into it or restarts it.
  // Somebody else's is decided again after it (a repeat of the same ask may then need nothing), or answered as their own turn.
  // Never forced into a turn of their own: they get their own decide once the running turn is done (addressed, code's floor answers them).
  if (message.from !== running.asker) {
    if (how === "fold" || how === "restart" || how === "queue" || tagged) return "redecide";
    if (decision.act === "react") await react();
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
    // The gateway could not stop it: decide wanted this one in a turn, so it waits for the next.
    if (!(await restartTurn(running, message))) return "after";
    for (const [key, item] of await storage.list<GroupPending>({ prefix: "gpending:" })) {
      if (item.ev !== undefined && running.covers.includes(item.ev)) await storage.put<GroupPending>(key, { ...item, force: true });
    }
    return "after";
  }
  // Addressed to Tex: answered after, whatever decide said (code's floor).
  if (how === "queue" || tagged) return "after";
  if (decision.act === "react") await react();
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
 * floor, on their own grant; Dev2's review, 2026-10-27, after the Seyi/Jhon
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

