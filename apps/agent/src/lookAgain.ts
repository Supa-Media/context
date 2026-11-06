/**
 * lookAgain: an answer's last look before it sends, the same step for a 1:1
 * chat and a group (Dev2's one-door plan, 2026-11-05: "make them the same as
 * much as possible so that people have the same experience"; the step is
 * drawn in `docs/architecture/tex.md`).
 *
 * The group review of 2026-10-30 found Tex answering a debugging question
 * with a reply about saving a playbook, drafted for an earlier ask: decide
 * decides once, when a turn starts, and nothing looked again before the reply
 * went out. A 1:1 chat had the same gap: a text that lands mid-turn and is
 * queued rather than folded in (`steer.ts`) left the reply to the older ask
 * going out as written.
 *
 * Now, when the asker has said more since the turn started and none of it was
 * folded into the turn, the control plane is asked whether the draft still
 * answers them (`recheck`, CONTRACT.md section 3b). Held, the turn ends as a
 * restart does: nothing it wrote is sent, its held asks are withdrawn by the
 * caller, and one new turn answers the old ask and the newer words together.
 * Each ask is looked at once, so a chat that keeps typing still gets an
 * answer. Recheck unreachable or unsure: sent, as before.
 *
 * What differs by chat is only where its queue lives and how its people are
 * named (`LookAgainChat`); the rule is one.
 */

import { recheck, type ControlDeps, type Style } from "./decide";
import { renderTranscript } from "./events";
import { chatEvents } from "./chatRead";
import type { InboxStorage } from "./inbox";
import { decidedByCode, type Pending } from "./inboxTurn";
import type { SendPart } from "./outgoing";

export type Rechecked = "send" | "held";

/** One waiting message as the look reads it: who sent it, its event, when it came, and whether code answers it. */
export type Waiting = { from: string; ev?: string; at?: number; byCode: boolean; rechecked?: true };

/** A chat's half of the step: its queue's prefix, how an item reads, and how one is marked for the next turn. */
export type LookAgainChat<Item> = {
  prefix: string;
  read: (item: Item) => Waiting;
  /** Marked so one turn answers it with the rest, and it is never looked at again. */
  mark: (item: Item) => Item;
  /** Who and where, for the recheck: the chat id, its line (groups), the sender, the style decide uses there. */
  chat: string;
  line?: string;
  style: Style;
};

/**
 * Whether the draft `text` written for `covers` (the turn's events, from
 * `sender`, the newest of them in at `upTo`) still goes out.
 * Only the asker's own newer words count: somebody else's text is their own turn.
 */
export async function lookAgain<Item>(
  storage: InboxStorage,
  deps: ControlDeps,
  chat: LookAgainChat<Item>,
  { sender, covers, upTo, text }: { sender: string; covers: readonly string[]; upTo: number; text: string },
): Promise<Rechecked> {
  if (text.trim() === "" || covers.length === 0) return "send";
  const pending = [...(await storage.list<Item>({ prefix: chat.prefix }))].map(([key, item]) => ({ key, item, seen: chat.read(item) }));
  const own = pending.filter(({ seen }) => seen.ev !== undefined && covers.includes(seen.ev));
  // Looked at once: the turn that answers both is never held again.
  if (own.some(({ seen }) => seen.rechecked)) return "send";
  // A command, a yes or a style choice is answered by code, never an ask that could change this one.
  const newer = pending.filter(({ seen }) => seen.from === sender && seen.ev !== undefined && !covers.includes(seen.ev) && !seen.byCode && (seen.at ?? 0) > upTo);
  if (newer.length === 0) return "send";
  const answer = await recheck(
    deps,
    {
      chat: chat.chat,
      ...(chat.line !== undefined ? { line: chat.line } : {}),
      sender,
      style: chat.style,
      // The chat's whole log, as decide is shown.
      transcript: renderTranscript(await chatEvents(storage, chat.chat)),
      candidates: [...covers, ...newer.map(({ seen }) => seen.ev!)],
      newest: newer.at(-1)!.seen.ev!,
    },
    text,
    covers.at(-1)!,
  );
  console.log(JSON.stringify({ event: chat.style === "direct" ? "texts_recheck" : "group_recheck", outcome: answer.ok ? (answer.fits ? "send" : "held") : "unavailable", ...(!answer.ok ? { reason: answer.cause } : {}), newer: newer.length }));
  if (!answer.ok || answer.fits) return "send";
  // One turn answers both, the old ask and the newer words.
  for (const { key, item } of [...own, ...newer]) await storage.put<Item>(key, chat.mark(item));
  return "held";
}

/**
 * The same look for a 1:1 chat (`inbox.ts` `answerTurn`): the turn answered `entries`, its reply `parts` not sent.
 * A text code answers (a yes, a code, a setting), a tapback, a job's report or the simulator never holds a reply.
 */
export async function lookAgainTexts(
  storage: InboxStorage,
  deps: ControlDeps,
  entries: readonly (readonly [string, Pending])[],
  parts: readonly SendPart[],
  started: number,
): Promise<Rechecked> {
  const message = entries.at(-1)![1].message;
  if (message.channel === "simulator" || message.jobReport !== undefined || decidedByCode(message)) return "send"; // a job's report is not an answer to their words
  const covers = entries.flatMap(([, entry]) => (entry.ev ? [entry.ev] : []));
  const upTo = Math.max(started, ...entries.map(([, entry]) => entry.at ?? 0));
  return await lookAgain<Pending>(
    storage,
    deps,
    {
      prefix: "pending:",
      read: (item) => ({
        from: item.message.chatId === message.chatId ? item.message.from : "",
        ev: item.ev,
        at: item.at,
        byCode: item.message.tapback !== undefined || decidedByCode(item.message), // `force` here only means the next turn answers it
        ...(item.rechecked ? { rechecked: true as const } : {}),
      }),
      // Forced entries are answered together by the next turn (`chooseTurn`: decide may not drop them).
      mark: (item) => ({ ...item, force: true, rechecked: true }),
      chat: message.chatId,
      style: "direct",
    },
    { sender: message.from, covers, upTo, text: parts.filter((part): part is string => typeof part === "string").join("\n\n") },
  );
}
