/**
 * A TURN THAT RUNS OUT OF STEPS STILL DELIVERS (owner, 2026-10-21).
 *
 * A research job in a group chat ran its eight rounds reading pages, then
 * texted "I ran out of steps before I finished that one. Here is where I got
 * to —" with nothing after it, and never wrote the note it was asked for.
 *
 * So the model is told before its last two rounds: the one before last is for
 * writing what it has where it belongs, and the last is for answering in
 * words. The bound itself is unchanged (a turn takes no extra model call), and
 * a turn that still ends on a tool call answers with the last words the model
 * wrote, not a promise of words that never come.
 */

export const FINISH_NOTICE =
  "(From Context, not the person: you have two steps left in this turn. Stop gathering. Use the next step to write what you " +
  "have where it belongs, such as the note they asked for, even if parts are unfinished, and say in it what's missing.)";

export const LAST_NOTICE =
  "(From Context, not the person: this is your last step. Answer them now in words, with no tool calls: what you did, where " +
  "it is, and what's left.)";

/** The notice for `round` of `rounds` (0-based), or null: never on a first round, so a one-round setup is unchanged. */
export function roundNotice(round, rounds) {
  if (round === 0 || rounds < 3) return null;
  if (round === rounds - 2) return FINISH_NOTICE;
  if (round === rounds - 1) return LAST_NOTICE;
  return null;
}

export const OUT_OF_STEPS = "I ran out of steps before I finished that one. Text me to carry on and I'll pick up where I stopped.";

/** What a turn that hit its bound answers: the model's last words, with the reason, or the reason alone. */
export function exhaustedAnswer(lastWords) {
  const words = typeof lastWords === "string" ? lastWords.trim() : "";
  return words ? `${words}\n\n${OUT_OF_STEPS}` : OUT_OF_STEPS;
}
