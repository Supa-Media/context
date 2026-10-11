/**
 * The landing pages' headline: "Tell Claude. ChatGPT already knows."
 *
 * Two names in one sentence, and the page retypes them in turn, each name's
 * own caret backspacing it and typing the next AI, so the sentence reads as a
 * note somebody is editing live. The second name goes first: "Tell Claude.
 * ChatGPT already knows." becomes "Tell Claude. Cursor already knows." and
 * then "Tell ChatGPT. Cursor already knows.", so every whole sentence the page
 * stops on is a true one, never "Tell ChatGPT. ChatGPT already knows."
 * The pairs walk one chain (Claude → ChatGPT → Cursor → Codex → Claude). Every pair is true today: each of these connects to the same
 * notes with one sign-in, so a note one of them saves is there for the other.
 *
 * Gemini CLI connects too, and the copy under the headline names it, but it
 * is not in the chain: "Tell Gemini CLI." is a third wider than "Tell
 * ChatGPT.", and a phone would have to set the whole sentence that much
 * smaller for one name.
 *
 * Pure data and a pure step function, so the timing and the claims are
 * tested without a browser (`__tests__/landingTell.test.ts`).
 */

/** An AI the headline names: its name, and the map colour it is drawn in. */
export type TellAi = "claude" | "chatgpt" | "cursor" | "codex";

export const TELL_NAMES: Record<TellAi, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  cursor: "Cursor",
  codex: "Codex",
};

/** The chain the sentence walks: pair i tells CHAIN[i] and CHAIN[i+1] knows. */
export const TELL_CHAIN: readonly TellAi[] = ["claude", "chatgpt", "cursor", "codex"];

/** The pair a frame shows: the AI told, and the AI that already knows. */
export function tellPair(index: number): readonly [TellAi, TellAi] {
  const n = TELL_CHAIN.length;
  const i = ((index % n) + n) % n;
  return [TELL_CHAIN[i], TELL_CHAIN[(i + 1) % n]];
}

/** The sentence as text: what a screen reader hears, and the first frame. */
export function tellSentence(index = 0): string {
  const [told, knows] = tellPair(index);
  return `Tell ${TELL_NAMES[told]}. ${TELL_NAMES[knows]} already knows.`;
}

/** One slot of the sentence as drawn: which AI it is, how much of its name is typed, and whether its caret is there. */
export type TellSlot = { ai: TellAi; typed: number; caret: boolean };

/** How long each part of a retype takes, in milliseconds. */
export const TELL_TIMING = {
  /** A full sentence held still before the next retype starts. */
  hold: 2600,
  /** One backspace. */
  erase: 45,
  /** The beat between the old name gone and the new one starting. */
  gap: 220,
  /** One typed letter. */
  type: 85,
  /** The caret stays a moment after the last letter, then leaves. */
  linger: 500,
  /** The first name starts this long after the second is done. */
  handoff: 260,
} as const;

/**
 * The steps from one pair to the next, as the frames to draw and how long
 * each stays up. The first frame is the current pair complete; the last is
 * the next pair complete, with no caret. A driver walks these with timers.
 */
export function tellSteps(index: number): { slots: readonly [TellSlot, TellSlot]; ms: number }[] {
  const [a0, b0] = tellPair(index);
  const [a1, b1] = tellPair(index + 1);
  const steps: { slots: readonly [TellSlot, TellSlot]; ms: number }[] = [];
  const full = (ai: TellAi): TellSlot => ({ ai, typed: TELL_NAMES[ai].length, caret: false });
  const push = (s0: TellSlot, s1: TellSlot, ms: number) => steps.push({ slots: [s0, s1], ms });

  push(full(a0), full(b0), TELL_TIMING.hold);
  retype(b0, b1, (slot, ms) => push(full(a0), slot, ms));
  push(full(a0), full(b1), TELL_TIMING.handoff);
  retype(a0, a1, (slot, ms) => push(slot, full(b1), ms));
  push(full(a1), full(b1), 0);
  return steps;
}

/** Backspace `from` to nothing in its own colour, then type `to` in its. */
function retype(from: TellAi, to: TellAi, emit: (slot: TellSlot, ms: number) => void): void {
  for (let n = TELL_NAMES[from].length; n > 0; n -= 1) {
    emit({ ai: from, typed: n, caret: true }, n === TELL_NAMES[from].length ? TELL_TIMING.gap : TELL_TIMING.erase);
  }
  emit({ ai: to, typed: 0, caret: true }, TELL_TIMING.gap);
  for (let n = 1; n <= TELL_NAMES[to].length; n += 1) {
    emit({ ai: to, typed: n, caret: true }, n === TELL_NAMES[to].length ? TELL_TIMING.linger : TELL_TIMING.type);
  }
}
