/**
 * THE LAST GUARD BEFORE ANY TEXT LEAVES (2026-11-17 23:00 UTC: a WhatsApp group's check-in posted "Nothing new
 * in the shared mailbox ... Nothing needs the group now. SKIP").
 *
 * A turn that decides to send nothing says so with a flag (`quiet`, the gateway's `say_nothing`;
 * `apps/mcp/src/agent/scheduledQuiet.js` for a scheduled turn). This is what stands behind that, for the day a
 * path forgets the flag: every text Tex sends, on every line (Sendblue, WhatsApp, Photon, Linq), 1:1 and group,
 * goes through `lineFor` (`line.ts`) or `groupLineFor` (`groupLine.ts`), and both wrap their line here. A text is
 * dropped, and the drop is logged, when:
 *
 *   - its decision is skip or quiet (`SendDecision`), whatever its words;
 *   - it is only a control word (`controlWords.ts`: SKIP, NOOP, NO_REPLY ...);
 *   - it ends with the quiet word as a token of its own, in capitals: "... Nothing needs the group now. SKIP",
 *     or a last paragraph that is only the word in any case;
 *   - it opens with the quiet word and then explains itself: "SKIP. Nothing new.", "SKIP - no mail".
 *
 * A text that only uses the word is still a text: "Want me to skip the Tuesday one?", "You can skip.",
 * "Tap SKIP in the top corner", "SKIP the queue with a pass". The price of the rule, known and accepted: an
 * answer whose very last word is SKIP in capitals ("... the button marked SKIP") is dropped too, because that is
 * exactly the shape of the leak, and a leak into a group is worse than one answer to re-ask.
 *
 * The log line carries a reason and a lane, never the words.
 */

import { isControlWord } from "./controlWords";

/** What a turn decided to do with its answer: only `send` reaches a chat. */
export type SendDecision = "send" | "skip" | "quiet" | "say_nothing";

/** Why a text was dropped; null when it may go. */
export type DropReason = "decision" | "control_word" | "trailing_sentinel" | "leading_sentinel";

const QUIET_DECISIONS: ReadonlySet<string> = new Set(["skip", "skipped", "quiet", "say_nothing", "silent"]);

/** The quiet word closing a text as its own token, in capitals (never the tail of a word, a handle, a tag or a path); closing quotes, brackets and a full stop may follow. */
const TRAILING = /(?:^|[^A-Za-z0-9@#/\\])SKIP[\s.!)\]"'\u201d\u2019*_`]*$/;
/** A last paragraph that is only the word, in any case, after other words; a list's last item ("- skip") is not one. */
const LAST_LINE_ONLY = /\n[^\S\n]*\n[^\S\n]*skip(?:ped)?[.!]?\s*$/i;
/** The quiet word opening a text and then set off from what follows: punctuation, a dash, a new line. */
const LEADING = /^[\s\W]*SKIP\s*(?:[.:;,!—–-]|\n)/;

/** Whether a text is, or carries at its edge, the word that means "send nothing". */
export function sentinelOf(text: string): Exclude<DropReason, "decision"> | null {
  const said = String(text ?? "").trim();
  if (said === "") return null;
  if (isControlWord(said)) return "control_word";
  if (TRAILING.test(said) || LAST_LINE_ONLY.test(said)) return "trailing_sentinel";
  if (LEADING.test(said)) return "leading_sentinel";
  return null;
}

/** Why this text must not be sent, or null when it may: its decision first, then its words. */
export function outboundDrop(text: string, decision?: SendDecision | string | null): DropReason | null {
  if (typeof decision === "string" && QUIET_DECISIONS.has(decision.toLowerCase())) return "decision";
  return sentinelOf(text);
}

/** One line per drop: the reason and the lane, never the words, a number or a name. */
export function logDrop(reason: DropReason, lane: string): void {
  console.log(JSON.stringify({ event: "outbound_dropped", reason, lane }));
}

/** Whether a text may go; a drop is logged here. */
export function maySend(text: string, lane: string, decision?: SendDecision | string | null): boolean {
  const reason = outboundDrop(text, decision);
  if (reason === null) return true;
  logDrop(reason, lane);
  return false;
}

/**
 * A line whose `sendText` drops what must never be sent: the text is its second argument on a 1:1 line and on a
 * group's. A dropped text resolves to no handle, as a line that names none does, so nothing is remembered for it.
 */
export function guardedLine<L extends { sendText(where: never, text: string, ...rest: never[]): Promise<string | undefined> }>(line: L, lane: string): L {
  const sendText = line.sendText.bind(line) as (...args: unknown[]) => Promise<string | undefined>;
  return {
    ...line,
    sendText: async (...args: unknown[]) => (maySend(String(args[1] ?? ""), lane) ? await sendText(...args) : undefined),
  } as L;
}
