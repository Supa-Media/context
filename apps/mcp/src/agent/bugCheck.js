/**
 * "FILE THIS AS A BUG" IS A BUG REPORT, NEVER A NOTE (Tex Devs group, 2026-10-26).
 *
 * Asked "File the fact that you can't see your own diagram and messages as a
 * bug report", Tex wrote into a team handoff note and texted "Filed."; Jhon:
 * "That is not a bug report!" A bug report is `report_problem`, which lands
 * in the Tex bug notes (`apps/convex/functions/bugNotes.ts`).
 *
 * So in a turn whose text asks to file a bug, a note write before the report
 * is refused with the reason, and an answer with no report gets one more
 * round to file it (`claimCheck.js`).
 */

import { asksToFile } from "../tools/reportGate.js";
import { REPORT_TOOL } from "../tools/reportProblem.js";
import { toolError } from "../tools/results.js";

/** Whether a step filed the report: sent, or held for their yes. */
const filed = (step) => (step.name === REPORT_TOOL || step.action === REPORT_TOOL) && (step.ok || step.held === true);

/** Whether their text asked for a bug report and none was filed this turn. */
export function filesABugElsewhere(question, answer, steps = []) {
  return typeof answer === "string" && asksToFile(question) && !steps.some(filed);
}

/** The refusal for a note write that comes before the report, or null to let it run. */
export function writeBeforeReport(question, name, args, steps = []) {
  if (!asksToFile(question) || steps.some(filed)) return null;
  const writes = name === "write_note" || name === "edit_note" || (name === "write" && (args?.action == null || args.action === "save"));
  if (!writes) return null;
  return toolError(
    "Not written: they asked for a bug report, and a note is not one. File it first with report_problem: two or three plain sentences on what went wrong and what they expected. " +
      "Write a note too only if they also asked for one.",
  );
}

export const BUG_NOTICE =
  "Before this goes: they asked you to file a bug report, and none was filed. A note (a handoff note, a backlog note, this chat's memory) is not a bug report. " +
  "Call report_problem now with two or three plain sentences: what went wrong and what they expected. Then say in one line that it's filed. " +
  "If report_problem refuses it, say so plainly; never say it's filed when it isn't.";

/*
  A LESSON FOR TEX IS NOT A FACT ABOUT THEM (the owner's review of a chat,
  2026-10-26). Told "take note of this please and make sure this never
  happens again" after a mistake, Tex wrote the lesson into tex/about-me.md:
  "that's common sense, not about me info". In a turn that asks for that,
  a write to about-me is refused with where it goes instead (`LESSONS_LINE`,
  `prompt.js`). "Take note that I'm vegetarian" is about them, so the words
  that mark a lesson are the ones about it happening again.
*/
const ASKS_FOR_A_LESSON =
  /\b(?:never happens? again|(?:does|do)n['’]?t happen again|(?:never|don['’]?t (?:ever )?)(?:do|say|let) (?:that|this)(?: happen)? again|not (?:to )?happen again|improvement agent)\b/i;
const ABOUT_ME = /(?:^|\/)tex\/about-me\.md$/i;

/** Whether their text asks Tex to learn from a mistake. */
export const asksForALesson = (question) => typeof question === "string" && ASKS_FOR_A_LESSON.test(question);

/** The refusal for an about-me write in a turn that asks for a lesson, or null to let it run. */
export function lessonInAboutMe(question, name, args) {
  if (!asksForALesson(question)) return null;
  const writes = name === "write_note" || name === "edit_note" || (name === "write" && (args?.action == null || args.action === "save"));
  const path = typeof args?.path === "string" ? args.path.trim() : "";
  if (!writes || !ABOUT_ME.test(path)) return null;
  return toolError(
    "Not written: tex/about-me.md is for facts about them, and this is a lesson about how you work. File it with report_problem (what went wrong, what should have happened) " +
      "so the people improving you see it, and fix what you can in this turn.",
  );
}
