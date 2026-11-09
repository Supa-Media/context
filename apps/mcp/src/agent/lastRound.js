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

/*
  A RUN NOBODY IS WAITING ON ENDS QUIET (Dev2, 2026-11-09). An hourly routine
  ran out of steps at 11 pm: told to write what it had into a note, it tried a
  write a routine is never given, and told to "answer them now in words", it
  texted three paragraphs about its own run ("I didn't text you"). A routine's
  or a check-in's last steps say silence is the answer when nothing is for them,
  and never ask for a note it can't write.
*/
export const FINISH_SCHEDULED_NOTICE =
  "(From Context, not the person: you have two steps left in this run, and nobody is waiting on it. Stop gathering. " +
  "If this run found nothing they need to hear, call send with action say_nothing now: the next run carries on.)";

export const LAST_SCHEDULED_NOTICE =
  "(From Context, not the person: this is your last step. If this run found something they need to hear, text it now in a line or two. " +
  "Otherwise call send with action say_nothing. Never text them about this run itself: what you tried, what failed, or what the next run will do.)";

/**
 * The notice for `round` of `rounds` (0-based), or null: never on a first round, so a one-round setup is unchanged.
 * `scheduled`: a routine's run or a check-in, which nobody texted for.
 */
export function roundNotice(round, rounds, { scheduled = false } = {}) {
  if (round === 0 || rounds < 3) return null;
  if (round === rounds - 2) return scheduled ? FINISH_SCHEDULED_NOTICE : FINISH_NOTICE;
  if (round === rounds - 1) return scheduled ? LAST_SCHEDULED_NOTICE : LAST_NOTICE;
  return null;
}

export const OUT_OF_STEPS = "I ran out of steps before I finished that one. Text me to carry on and I'll pick up where I stopped.";

/** What a turn that hit its bound answers: the model's last words, with the reason, or the reason alone. */
export function exhaustedAnswer(lastWords) {
  const words = typeof lastWords === "string" ? lastWords.trim() : "";
  return words ? `${words}\n\n${OUT_OF_STEPS}` : OUT_OF_STEPS;
}
