/**
 * Pages in the gateway: the checks a `.page.md` write passes (its blocks can
 * be drawn, and its writer read the page design skill), and what agents are
 * given (`orient about: "pages"` answers the skill, `pageSkill.js`; background jobs are told the line below). The format
 * itself is `packages/shared/src/pages/`, the same copy the app and the page
 * runtime read.
 *
 * Decision: `docs/decisions/app-and-console/pages.md`.
 */

// Each file by itself: Node's ESM import sees a CommonJS file's names only when it lists them plainly.
import { frontMatter, isPagePath, parsePage } from "../../../packages/shared/src/pages/parse.cjs";
import { PAGE_SKILL, PAGE_SKILL_STAMP } from "./pageSkill.js";

export { isPagePath };

/** At most this many problems are listed; the rest are counted. */
const MAX_LISTED = 8;

function lineAt(content, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Why a page cannot be saved as written, or null when it can. The checks are
 * for the writer (a chart with no numbers, a choice of one), never for
 * safety: the runtime escapes every word and draws whatever it is given.
 */
export function pageProblems(content) {
  const { problems } = parsePage(content);
  if (problems.length === 0) return null;
  const listed = problems.slice(0, MAX_LISTED).map((problem) => `- line ${lineAt(content, problem.from)}: ${problem.message}`);
  const more = problems.length > MAX_LISTED ? [`- and ${problems.length - MAX_LISTED} more.`] : [];
  return [
    "this page has blocks that cannot be drawn, so it was not saved:",
    ...listed,
    ...more,
    'Fix them and write again. orient about: "pages" has the format.',
  ].join("\n");
}

/** What `orient about: "pages"` answers: the page design skill, which ends with its stamp (`pageSkill.js`). */
export const PAGE_GUIDE = PAGE_SKILL;

/**
 * Why a page may not be written by this caller yet: its front matter does not
 * carry the current skill stamp, so whoever wrote it has not read the page
 * design skill as it is now (owner, 2026-10-27: "skill should be required
 * when making pages"). Null when it does.
 */
export function pageSkillMissing(content) {
  const { fields } = frontMatter(typeof content === "string" ? content : "");
  if (String(fields.skill ?? "").trim() === PAGE_SKILL_STAMP) return null;
  return [
    fields.skill ? "this page was written to an older page design skill, so it was not saved." : "this page was not saved: read the page design skill first.",
    'Read it with orient about: "pages", follow it, and put the stamp it ends with in the page\'s front matter (skill: ...).',
  ].join(" ");
}

/** The line a background job is told about writing its result as a page. */
export const PAGE_JOB_LINE =
  "Write the deliverable as a page: a note named `<name>.page.md`. Read the page design skill first (orient about: \"pages\"): " +
  "it says what goes first (the answer, then your pick as a vote), which block fits which facts (places, prices, tiers, itinerary, stats, timeline, contacts), " +
  "and the stamp a page must carry; a page without it, or with a block that cannot be drawn, is refused with what to fix.";
