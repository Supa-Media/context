/**
 * Which of a group's waiting messages one turn answers, decided by the
 * control plane (`decide.ts`, the group's style) instead of by hand (Dev2,
 * 2026-10-26, reversing "two people's texts are two questions"). What
 * reaches decide at all is the style's (`groupStyle.ts`); decide unreachable,
 * a group answers what `addressesTex` accepted, one at a time, with what
 * its sender sent right after it (`withJoins`), as before. Addressed, its turn
 * starts at once and decide is asked beside it; decide's silent drops the
 * answer unsent (`decideBeside`, Dev2, 2026-11-01). Kept as code: only the asker's yes releases what was held, a
 * style choice and the commands are never put to decide, and a newcomer's
 * transcript starts where they joined (`renderTranscript` with `people`).
 */

import { chatEvent } from "./chatState";
import type { SettingReply } from "./texStyle";
import { MAX_INBOUND_ATTACHMENTS } from "./inbound";
import { addEvent, keptEvents, kindOf, markStale, renderTranscript, waitingAsks } from "./events";
import { decide, GROUP_DECIDE_MS, MAX_CANDIDATES, RUNNING_DECIDE_MS, type ControlDeps, type Decision, type GroupStyle } from "./decide";
import { eventPeople, sha256Hex } from "./groupChat";
import { restartTurn, steerInto, type Live } from "./steer";
import { PICTURE_LINE } from "./groupLines";
import { burstStillTyped, decideDownAnswer } from "./groupPolicy";
import { groupStyle, movedOn } from "./groupStyle";
import { addressesTex } from "./groupWords";
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
  /** A reply to the open "Tex, settings" menu (`texStyle.ts`), answered by code. */
  setting?: SettingReply;
  /** On a turn kept for a retry: the events it answers besides its own. */
  covers?: string[];
  /** The message the style question held: never asked about again. */
  styleAsked?: true;
  /** What the chat said up to here is the turn's context (somebody else's lines decide covered with it). */
  contextUntil?: number;
  /** Sent by the tagger a moment after their own waiting tag (`followsOwnTag`): it goes with that tag. */
  joins?: true;
  /** Tex already reacted to it (decide's emoji, `chatState.ts`): the turn that answers it adds no second tapback. */
  reacted?: true;
  /** A turn's draft for it was held by `recheckDraft` once already: the next answer is sent. */
  rechecked?: true;
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

async function ask(storage: InboxStorage, deps: ControlDeps & { now: () => number }, newest: GroupMessage, candidates: string[], running: boolean, addressed = false): Promise<Decision> {
  const style = (await groupStyle(storage)).style;
  const decision = await decide(
    deps,
    {
      chat: newest.groupId,
      line: newest.line,
      sender: newest.from,
      style,
      // The chat's whole log, whoever has joined or left since (the owner, 2026-11-02).
      transcript: renderTranscript(await keptEvents(storage, newest.groupId)),
      candidates,
      running,
      // Only the sender's own asks: nobody else's "nah forget it" can end somebody's ask.
      waitingAsks: await waitingAsks(storage, deps.now(), await sha256Hex(newest.from)),
      newest: candidates.at(-1) ?? "",
      // It looks addressed (`addressesTex`): decide is told, so a real ask is not read as chatter.
      ...(addressed ? { addressed: true as const } : {}),
    },
    running ? RUNNING_DECIDE_MS : GROUP_DECIDE_MS,
  );
  // Codes only: the act, or why decide could not answer.
  console.log(
    JSON.stringify({
      event: "group_decide",
      outcome: decision.ok ? decision.act : decision.reason,
      ...(!decision.ok && decision.cause ? { reason: decision.cause } : {}),
      ...(decision.ms !== undefined ? { ms: decision.ms } : {}),
      ...(running ? { kind: "running" } : addressed ? { kind: "addressed" } : {}),
    }),
  );
  if (decision.ok) {
    await markStale(storage, decision.stale);
    if (decision.movedOn) await movedOn(storage);
  }
  return decision;
}

/**
 * `react`/`emoji`: a reaction on the newest message, sent at once, with an answer, a wait or alone (reacting is its
 * own decision, Dev2 2026-11-01; `reactionFor` checks the emoji). `wait`: untagged messages held for the rest of
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
 * oldest first). A message addressed to Tex (its name opening or closing it, an @-tag, a reply to Tex)
 * starts its turn at once, with what joined it, so a burst holding one is
 * chosen by code (`addressedTurn`), never waiting on decide: decide is asked
 * beside the turn, and only its silent keeps the answer from going
 * (`decideBeside`; Dev2, 2026-11-01, ending the floor of 2026-10-27). Decide chooses only for
 * a burst of untagged messages: whether they are answered, and which of
 * them an answer covers. Decide down: an untagged question that reached
 * decide (its style reads it) is answered, so a follow-up is never dropped
 * silently; other untagged ones become chat lines.
 */
export async function chooseGroupTurn(storage: InboxStorage, deps: ControlDeps & { now: () => number }, burst: GroupEntry[], waitAllowed = false): Promise<GroupChoice> {
  // Addressed: its turn starts now, and decide is asked beside it (`decideBeside`), never waited on (up to GROUP_DECIDE_MS) first.
  const named = addressedTurn(burst);
  if (named !== null) return named;
  const ids = burst.flatMap(([, item]) => (item.ev ? [item.ev] : []));
  if (ids.length === 0) console.log(JSON.stringify({ event: "group_decide", outcome: "unavailable", reason: "no_events" }));
  const decision = ids.length === 0 ? ({ ok: false, reason: "unavailable" } as const) : await ask(storage, deps, burst.at(-1)![1].message, ids, false);
  // Nothing here is addressed (`addressedTurn` took those): every message is one decide reads.
  if (!decision.ok) {
    const question = decideDownAnswer(burst.map(([, item]) => item));
    return question === -1 ? { answer: [], chat: burst, drop: [] } : { answer: [burst[question]], chat: burst.filter((_, index) => index !== question), drop: [] };
  }
  // A wait holds only a real burst, and only while the chat's state allows one more (`canWait`): otherwise an answer.
  const act = decision.act === "wait" && !(waitAllowed && burstStillTyped(burst.map(([, item]) => item))) ? "answer" : decision.act;
  // One reaction per message: decide's, at once, whatever it decided about words.
  const newest = burst.at(-1)!;
  const react = (act === "react" || decision.emoji !== undefined) && !newest[1].reacted ? { react: newest, ...(decision.emoji ? { emoji: decision.emoji } : {}) } : {};
  if (act === "wait") return { answer: [], chat: [], drop: [], wait: burst, waitSeconds: decision.waitSeconds ?? 1, ...react };
  if (act !== "answer") return { answer: [], chat: burst, drop: [], ...react };
  const chosen = burst.filter((entry) => entry[1].ev !== undefined && decision.covers.includes(entry[1].ev));
  const answer = chosen.length > 0 ? chosen : [burst.at(-1)!];
  const last = burst.indexOf(answer.at(-1)!);
  // Left out before the answer: chat.
  return { answer, chat: burst.slice(0, last).filter((entry) => !answer.includes(entry)), drop: [], ...react };
}

/**
 * A burst holding a message addressed to Tex, chosen without decide (the
 * group review of 2026-10-30: a named message waited up to 15s on a decide
 * whose answer could not change that it is answered). Every addressed
 * message is answered with what joined it (`ownTurn` then keeps the first
 * one's sender's). That sender's own untagged lines before it are chat, so
 * the turn reads them; anybody else's untagged line, and any after it, stays
 * waiting, decided on the next pass as decide would have had it, for its own
 * sender. Null when nothing is addressed.
 */
export function addressedTurn(burst: GroupEntry[]): GroupChoice | null {
  const first = burst.findIndex((entry) => !soft(entry));
  if (first === -1) return null;
  const answer = [...new Set(burst.filter((entry) => !soft(entry)).flatMap((entry) => withJoins(burst, entry)))];
  const asker = burst[first][1].message.from;
  return { answer, chat: burst.slice(0, first).filter((entry) => entry[1].message.from === asker), drop: [] };
}

/**
 * Decide on a turn that started because it looked addressed, asked beside it
 * (Dev2, 2026-11-01: decide judges every group message, and an addressed one
 * is not held for it). True when decide says Tex stays silent (a react
 * included: the turn already put its ack on the message); down, slow
 * (`GROUP_DECIDE_MS`) or anything else, false, and the answer goes, as it did
 * before decide. Undefined when nothing in the turn's words is addressed: a
 * command, a yes or a retried turn is code's (`byCode`), decide already chose
 * an untagged one, and a reaction answering Tex's question is never left
 * silent (`reactions-as-input.md`). Metered as any group decide, on the
 * chat's workspace.
 */
export function decideBeside(storage: InboxStorage, deps: ControlDeps & { now: () => number }, entries: GroupEntry[]): Promise<boolean> | undefined {
  const head = entries.filter(([, item]) => !item.soft && !item.byCode && addressesTex(item.message.text, item.message.replyTo !== undefined)).at(-1);
  // Up to the newest addressed message, so decide judges that one, not a picture that joined it.
  const ids = head === undefined ? [] : entries.slice(0, entries.indexOf(head) + 1).flatMap(([, item]) => (item.ev ? [item.ev] : []));
  if (head === undefined || ids.length === 0) return undefined;
  return ask(storage, deps, head[1].message, ids, false, true).then(
    (decision) => decision.ok && (decision.act === "silent" || decision.act === "react"),
    () => false,
  );
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

