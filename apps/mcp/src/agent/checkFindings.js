/**
 * EVERY CODE CHECK READS A DRAFT TOGETHER, AND IT GOES BACK ONCE WITH ALL OF
 * THEM (Dev2's "jobs as config" plan, 2026-11-17, part A).
 *
 * On 2026-11-17 a timecards job's parts were each sent back three times, one
 * check at a time: "make it a page, not a text", then "that's an essay", then
 * "send ONE casual line". Each cost a model round, each rewrite tripped the
 * next check, and the third send-back crashed the part, so the answer it had
 * was thrown away ten times. The checks ran as a chain where the first to fire
 * won and the rest waited for the rewrite.
 *
 * Now `claimCheck.js` and `replyChecks.js` collect every finding on a draft,
 * and this file turns them into the one notice that goes back:
 *
 *   - A **fact** is something the turn's own record proves wrong: a change
 *     claimed with no call, a link nothing gave, a figure nothing read, a
 *     browser never tried, a search handed back to them. Facts block: any fact
 *     sends the draft back, every fact found listed in one notice.
 *   - **Advice** is about shape: a page rather than a text, too wordy, one
 *     line beside a page, a card for a list, a plain note that should be a page. It never holds an
 *     answer on its own in a job (the job's report is reviewed later), and on
 *     a chat turn it may cost one rewrite a turn at most. It rides along when
 *     a fact sends the draft back anyway.
 *   - Of the shape advice that says how long or in what form the answer
 *     should be (`SHAPE`), at most one is ever given in a turn, so two never
 *     contradict each other ("make it a page" then "that's an essay").
 *
 * A single finding goes back word for word as its check wrote it.
 */

/** The advice that says what form or length the answer takes: only one of these a turn, the first that fires in this order. */
export const SHAPE = ["page", "work", "card", "result", "wordy"];

/**
 * The facts that all say "you gave up too soon" in different words: at most `GIVE_UPS` of them go back on one draft,
 * the most exact first, so a give-up draft is not handed six overlapping notices at once.
 */
export const GIVE_UP = ["retry", "untried", "sites", "look", "paste", "routes", "handback"];
export const GIVE_UPS = 2;

/** Facts that themselves say what shape the answer takes ("draw it, then ONE line"): with one, no shape advice goes. */
export const SHAPED_FACTS = ["owed-picture"];

/** A finding: `{ kind, notice, advice }`. A fact unless `advice` is true. */
export function finding(kind, notice, advice = false) {
  return { kind, notice: String(notice), advice: advice === true };
}

/** A notice's own words without the "Before this goes:" each one opens with, for a list of several. */
function body(notice) {
  return String(notice).replace(/^\s*Before this goes:\s*/i, "").trim();
}

/** Caps the give-up facts (`GIVE_UPS`), and keeps at most one `SHAPE` advice, the first in `SHAPE`'s order, and none at all once one was given this turn (`shapeGiven`). */
export function oneShape(found, shapeGiven = false) {
  const giveUps = found.filter((entry) => !entry.advice && GIVE_UP.includes(entry.kind)).sort((a, b) => GIVE_UP.indexOf(a.kind) - GIVE_UP.indexOf(b.kind));
  if (giveUps.length > GIVE_UPS) found = found.filter((entry) => !giveUps.slice(GIVE_UPS).includes(entry));
  if (found.some((entry) => !entry.advice && SHAPED_FACTS.includes(entry.kind))) shapeGiven = true;
  const shaped = found.filter((entry) => entry.advice && SHAPE.includes(entry.kind));
  if (shaped.length === 0) return found;
  const keep = shapeGiven ? null : shaped.reduce((best, entry) => (SHAPE.indexOf(entry.kind) < SHAPE.indexOf(best.kind) ? entry : best));
  return found.filter((entry) => !(entry.advice && SHAPE.includes(entry.kind)) || entry === keep);
}

/**
 * The one notice for a draft's findings, or null to let it go. `adviceAlone`:
 * whether advice with no fact beside it may still send the draft back (a chat
 * turn's first advice, never a job's).
 */
export function combineFindings(found, { adviceAlone = false } = {}) {
  const facts = found.filter((entry) => !entry.advice);
  const advice = found.filter((entry) => entry.advice);
  if (facts.length === 0 && (advice.length === 0 || !adviceAlone)) return null;
  if (facts.length + advice.length === 1) return (facts[0] ?? advice[0]).notice;
  const parts = [];
  if (facts.length === 1) parts.push(facts[0].notice);
  if (facts.length > 1) {
    parts.push(`Before this goes, check ${facts.length} things against what this turn did, and fix what needs it in one rewrite:`);
    facts.forEach((entry, at) => parts.push(`${at + 1}. ${body(entry.notice)}`));
  }
  if (advice.length > 0) {
    parts.push(facts.length > 0 ? "Also, advice on its shape: take it in the same rewrite where it fits, and it is never a reason to hold the answer back:" : "Before this goes, advice on its shape: take what fits, then send it:");
    for (const entry of advice) parts.push(`- ${body(entry.notice)}`);
  }
  return parts.join("\n\n");
}

/** Whether a notice that went back carries this one: it is that notice, or lists its words among others. */
export function carries(notice, one) {
  if (typeof notice !== "string" || typeof one !== "string") return false;
  return notice === one || notice.includes(body(one));
}
