/**
 * A WRITE-UP THAT SHOULD HAVE BEEN A PAGE (owner, 2026-10-27, 21:03: "WHY THE
 * HECK IS IT GIVING ME A PLAIN MARKDOWN FOR THIS, THIS SHOULD HAVE BEEN A WELL
 * DESIGNED PAGE"). Asked by text for "a detailed plan for putting on a 100
 * person concert in nyc", Tex saved `projects/100-person-concert/plan.md`, a
 * checklist under headings, and texted its link. Only background jobs were
 * told to write their result as a page (`PAGE_JOB_LINE`); a texted turn never
 * was.
 *
 * Then (21:08): "by default every note that tex produces should be a page,
 * and only ever a regular note when the user explicitly asks". So a texted
 * turn's writes are read once (`claimCheck.js`): a new plain note, outside
 * Tex's own folders and records, goes back with this notice, which carries
 * the page design skill, and Tex writes it as a page. A change to a note they
 * already have keeps its form. The prompt's line says it first; this is the floor.
 */

import { activityHintOf } from "../live/activityHint.js";
import { isPagePath } from "../pages.js";
import { PAGE_SKILL } from "../pageSkill.js";

/** They asked, in so many words, for a plain note: the one case a new note is not a page. */
const ASKS_PLAIN = /\b(?:(?:plain|regular|normal|simple|ordinary|markdown|md) (?:note|markdown|text|file)|not (?:as )?a page|no page|without a page)\b/i;

/** Tex's own notes and records that stay plain: to-dos, memory, front pages, routines, chats, transcripts, the inbox. */
const NOT_A_PAGE = /(?:^|\/)(?:todo|about-me|index|about)\.md$|^(?:@[^/]+\/)?(?:tex|inbox|\.context|routines)\//i;

/**
 * The note writes a turn made, as `{ path, content, created }`, from a call to
 * `write_note` or the six-tool `write`. Whether it created the note is the
 * write's own answer (its activity hint) when the result carries one; without
 * it, a write that passed no etag counts as new.
 */
export function noteWrite(name, args, result) {
  if (name !== "write_note" && name !== "write") return null;
  const call = args && typeof args === "object" ? args : {};
  if (name === "write" && typeof call.action === "string" && call.action !== "" && call.action !== "save") return null;
  const path = typeof call.path === "string" ? call.path.trim().replace(/^\/+/, "") : "";
  const content = typeof call.content === "string" ? call.content : "";
  if (!path || !content) return null;
  const said = activityHintOf(result)?.created;
  const created = typeof said === "boolean" ? said : typeof call.expected_etag !== "string" && typeof call.etag !== "string";
  return { path, content, created };
}

/**
 * The plain note this turn should have written as a page, or null: a new
 * note (no etag passed) outside Tex's own folders and records, when they did
 * not ask for a plain note. A change to a note they already have keeps its
 * form. `writes` are the turn's successful note writes (`noteWrite`).
 */
export function wantsAPage(writes, question = "") {
  if (!Array.isArray(writes) || writes.length === 0) return null;
  if (ASKS_PLAIN.test(String(question ?? ""))) return null;
  // It wrote the page too (the plain copy is archived by the page's own steps).
  if (writes.some((write) => isPagePath(write.path))) return null;
  return writes.find((write) => write.created && !isPagePath(write.path) && !NOT_A_PAGE.test(write.path) && /\.md$/i.test(write.path))?.path ?? null;
}

/** What Tex is told: write it as a page, with the skill right here, then archive the plain copy. */
export function pageNotice(path) {
  const page = path.replace(/\.md$/i, ".page.md");
  return [
    `You saved ${path} as a plain note, but every new note you make is a designed page unless they asked for a plain note.`,
    `Write it again now as ${page}, following the page design skill below (its stamp goes in the front matter), with every fact from the plain note.`,
    `Then archive ${path} with archive_note, draw the page's cover (send action draw_visual, template page, data { path: "${page}" }) and text the cover and the page's link.`,
    "Your reply is one line about the page, never the plain note's link.",
    "",
    PAGE_SKILL,
  ].join("\n");
}
