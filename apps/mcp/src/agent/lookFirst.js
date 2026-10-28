/**
 * LOOK BEFORE ASKING, AND "FIX YOURSELF" MEANS LOOK AT WHAT JUST FAILED
 * (Tex's self-review themes asks-for-findable-info and self-repair-on-request,
 * 2026-10-27 and 2026-10-28; the owner's rule that Tex never asks for or
 * hands back what it can do itself, docs/decisions/texting-assistant/handing-back.md).
 *
 * Three reviewed chats asked the person what Tex could have found:
 *
 *   - "Which email addresses should I use?" for two caterers, and a turn
 *     later an events@ address it had just said wasn't there, with no word
 *     that it had corrected itself or where the address came from.
 *   - A work-block routine asked when they started and stopped, which the
 *     block's log and the note's edit times already said.
 *   - Right after a group chat full of failed page saves, "Tex please fix
 *     yourself" got "Tell me what's broken, and I'll fix it." The chat's own
 *     recent turns said what was broken.
 *
 * Every turn is told to look first (`LOOK_FIRST_LINE`, in `prompt.js`'s
 * ground rules). The hand-back judge is told that the chat's earlier turns
 * and Tex's own logs are places it can look (`handbackJudge.js`). And a turn
 * whose text asks Tex to fix itself, answered by asking what's wrong or with
 * nothing tried, gets one more round to name the failure, retry it once and
 * file it (`selfRepairNotice`, from `claimCheck.js`).
 *
 * Nothing here reads a tool's result: only the person's words, the answer's
 * own words, and the names of the calls the turn made.
 */

export const LOOK_FIRST_LINE =
  "Before asking them anything, look yourself: this chat's earlier texts and what your earlier turns did or failed at, your notes and logs (a routine's log, a note's edit time), their email, calendar and the web. " +
  "Ask only what none of those settle. If what you find corrects an earlier answer, say so and where you found it. " +
  "Asked to fix yourself, find what failed in this chat's recent turns, name it in one line, retry it once, and file it with report_problem; never ask what's broken.";

/** "fix yourself", "Tex please fix urself", "repair yourself", "self-heal". */
const FIX_YOURSELF = /\b(?:fix|repair|debug|heal|sort out)\s+(?:your\s*self|ur\s*self|yo\s*self)\b|\bself[- ]?(?:fix|repair|heal)\b/i;

/** Whether their text asks Tex to fix itself. */
export function asksToFixItself(question) {
  return typeof question === "string" && FIX_YOURSELF.test(question.replace(/[‘’]/g, "'"));
}

/** "Tell me what's broken", "What went wrong?", "Which part isn't working?": the answer asks them what failed. */
const ASKS_WHATS_WRONG = [
  /\bwhat(?:'s| is| was|'s been)\s+(?:broken|wrong|off|not working|failing|going on|the (?:problem|issue|bug|error))\b/i,
  /\bwhat\s+(?:went wrong|happened|broke|failed|isn't working|is not working|needs fixing)\b/i,
  /\bwhich\s+(?:part|thing|bit|feature|step|one)\b[^.?!\n]{0,40}?\b(?:broken|wrong|failing|failed|fix|isn't|not working)\b/i,
  /\b(?:tell|show|remind)\s+me\s+(?:what|which|where)\b/i,
  /\b(?:describe|explain)\s+(?:the|what)\b[^.?!\n]{0,30}?\b(?:problem|issue|wrong|broken|happened)\b/i,
];

export function asksWhatsWrong(answer) {
  const said = String(answer ?? "").replace(/[‘’]/g, "'");
  return ASKS_WHATS_WRONG.some((pattern) => pattern.test(said));
}

export const SELF_REPAIR_NOTICE =
  "Before this goes: they asked you to fix yourself, and this chat already shows what went wrong. Don't ask them. " +
  "Read this chat's recent turns: your own answers that say something failed or couldn't be saved, texts that weren't delivered, asks left unanswered. " +
  "Name the failure in one line, try that failed step once more now, and say whether it worked. " +
  "Then file it with report_problem in two or three plain sentences (what failed, what they expected) so the people improving you see it; it waits for their yes. " +
  "Only if the chat shows nothing that failed, say you looked and found nothing, and ask what they saw.";

/**
 * One more round for a "fix yourself" turn whose answer asks them what's
 * wrong, or that ran no tool at all; null otherwise. `steps` are
 * the turn's calls as `{ name, ok }`.
 */
export function selfRepairNotice(question, answer, steps = []) {
  if (typeof answer !== "string" || !asksToFixItself(question)) return null;
  if (asksWhatsWrong(answer)) return SELF_REPAIR_NOTICE;
  return steps.length === 0 ? SELF_REPAIR_NOTICE : null;
}
