/**
 * One turn of a Replay moment, as `prodRun.ts` plays it on the canvas: what
 * started it (a text someone sent, or a check-in, a routine or a ping from its own start step), its measured times
 * and everything each step got and gave, and the prompt it ran on. The texting Worker's judgings in the moment before
 * the turn's text was sent count as its Decide step. Read from the ledger alone, so the gateway's `tex_dev` answers
 * the same (`replayEntry.ts`).
 */
import type { LedgerEntry } from "../fromApp/texPageTypes";
import type { ChatLine, MyText, Start } from "./mine";
import { momentTurnEntries, realIO, realTimes, type IoLine, type RealTimes } from "./measured";
import { turnPromptOf, type TurnPrompt } from "./promptAt";
import { startLabel, type Moment } from "./replay";

export type TurnShown = {
  /** What the canvas traces: the text someone sent, or the start step's label. */
  text: string;
  /** The start step it traces from, when Tex texted on its own. */
  start?: Start;
  /** The person's text it answers, when one did. */
  asked: MyText | null;
  times: RealTimes | null;
  io: Record<string, IoLine[]>;
  prompt: TurnPrompt | null;
  /** The entries it was read from: the chat's, with the moment's Worker steps given to the turn. */
  entries: LedgerEntry[];
};

/** The turn `turn` of moment `m`, or null when nothing started it that the canvas can trace. */
export function turnShown(m: Moment, lines: ChatLine[], entries: LedgerEntry[], turn: string): TurnShown | null {
  const all = momentTurnEntries(m, entries, turn);
  const asked = lines.find((l) => l.play?.turn === turn)?.play ?? (m.from === "text" ? m.lines.find((l) => l.play)?.play : null) ?? null;
  if (asked) {
    const io = realIO(all, turn, asked.text, asked.then.text, asked.who ? `${asked.who}'s text` : "Your text");
    return { text: asked.text, asked, times: realTimes(all, turn), io, prompt: turnPromptOf(all, turn), entries: all };
  }
  const own = m.lines[0];
  if (!own?.start) return null;
  // Tex texting on its own: the start step's words are what it was asked, as the turn was given them.
  const label = startLabel(own);
  const io = realIO(all, turn, own.about || label, own.text, label);
  io[own.start] = [{ k: "Started", v: own.about || label }];
  return { text: label, start: own.start, asked: null, times: realTimes(all, turn), io, prompt: turnPromptOf(all, turn), entries: all };
}
