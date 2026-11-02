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
import { ASKS_FOR_PAGE } from "./theirNotes.js";

/** They asked, in so many words, for a plain note: the one case a new note is not a page. */
const ASKS_PLAIN = /\b(?:(?:plain|regular|normal|simple|ordinary|markdown|md) (?:note|markdown|text|file)|not (?:as )?a page|no page|without a page)\b/i;

/**
 * Tex's own notes and records that stay plain: to-dos, memory, front pages,
 * routines, chats, transcripts, the inbox. A guest chat's folder,
 * `tex/chats/<words>/`, is not one of them: it is the only place a group chat
 * with guests may write, so what Tex makes for that chat lands there and is a
 * page like any other (2026-10-28: the research for a WhatsApp guest chat was
 * saved plain twice, and never sent back, because the folder sits under tex/).
 * The chat's own notes in its home (`history.md`, `voice.md`, `about.md`) stay plain: they are under tex/.
 */
const NOT_A_PAGE = /(?:^|\/)(?:todo|about-me|index|about|chat-[0-9a-f]+)\.md$|^(?:@[^/]+\/)?(?:tex(?!\/chats\/[^/]+\/)|inbox|\.context|routines)\//i;

/**
 * The note writes a turn made, as `{ path, content, created }`, from a call to
 * `write_note` or the six-tool `write`. Whether it created the note is the
 * write's own answer (its activity hint). Without one it is a change, never a
 * new note: a write with no etag may overwrite a note they already have, and
 * reading that as new is how their Joshua 1 was archived for a page
 * (2026-10-30, `theirNotes.js`).
 */
export function noteWrite(name, args, result) {
  if (name !== "write_note" && name !== "write") return null;
  const call = args && typeof args === "object" ? args : {};
  if (name === "write" && typeof call.action === "string" && call.action !== "" && call.action !== "save") return null;
  const path = typeof call.path === "string" ? call.path.trim().replace(/^\/+/, "") : "";
  const content = typeof call.content === "string" ? call.content : "";
  if (!path || !content) return null;
  const created = activityHintOf(result)?.created === true && typeof call.expected_etag !== "string" && typeof call.etag !== "string";
  return { path, content, created };
}

/**
 * The plain note this turn should have written as a page, or null: a new
 * note (no etag passed) outside Tex's own folders and records, when they did
 * not ask for a plain note, and not one among their plain notes (`follows`,
 * set from `amongPlainNotes`). A change to a note they already have keeps its
 * form. `writes` are the turn's successful note writes (`noteWrite`).
 */
export function wantsAPage(writes, question = "") {
  if (!Array.isArray(writes) || writes.length === 0) return null;
  if (ASKS_PLAIN.test(String(question ?? ""))) return null;
  // It wrote the page too (the plain copy is archived by the page's own steps).
  if (writes.some((write) => isPagePath(write.path))) return null;
  return writes.find((write) => write.created && !write.follows && !isPagePath(write.path) && !NOT_A_PAGE.test(write.path) && /\.md$/i.test(write.path))?.path ?? null;
}

/**
 * Whether the folder `path` sits in already holds their plain notes, read
 * from a listing of it (`path (N bytes)` lines). A new note among them
 * follows its neighbours' form: a chapter note beside the person's plain
 * chapter notes stays plain (owner, 2026-10-30: Joshua 1, among
 * Deuteronomy's, came back an "ugly page"). Front pages and pages don't count.
 */
export function amongPlainNotes(listing, path) {
  const cut = path.lastIndexOf("/");
  const folder = cut === -1 ? "" : path.slice(0, cut + 1);
  const self = path.toLowerCase();
  return String(listing ?? "")
    .split("\n")
    .map((line) => line.replace(/\s+\(\d[\d,]* bytes\)\s*$/, "").trim())
    .some((key) => {
      if (!key.startsWith(folder) || key.toLowerCase() === self) return false;
      const name = key.slice(folder.length);
      return !name.includes("/") && /\.md$/i.test(name) && !isPagePath(name) && !/^(?:about|index)\.md$/i.test(name);
    });
}

/**
 * `noteWrite`, and for a new plain note whether it sits among their plain
 * notes (`follows`, from a listing of its folder), unless they asked for a
 * page. A listing that fails says no. What the turn's watcher keeps.
 */
export async function turnNoteWrite(name, args, result, { callTool, question = "" }) {
  const written = noteWrite(name, args, result);
  if (written === null || !written.created || isPagePath(written.path) || ASKS_FOR_PAGE.test(String(question ?? ""))) return written;
  const cut = written.path.lastIndexOf("/");
  const context = typeof args?.context === "string" && args.context !== "" ? { context: args.context } : {};
  try {
    const listed = await callTool("list_notes", { prefix: cut === -1 ? "" : written.path.slice(0, cut + 1), ...context });
    written.follows = listed?.isError !== true && amongPlainNotes(listed?.content?.[0]?.text, written.path);
  } catch {
    written.follows = false;
  }
  return written;
}

/** What Tex is told: write it as a page, with the skill right here, then archive the plain copy. */
export function pageNotice(path) {
  const page = path.replace(/\.md$/i, ".page.md");
  return [
    `You saved ${path} as a plain note, but every new note you make is a designed page unless they asked for a plain note.`,
    `Write it again now as ${page}, following the page design skill below (its stamp goes in the front matter), with every fact from the plain note.`,
    `Then archive ${path}, the plain copy you made this turn, with archive_note (never any other note), draw the page's cover (send action draw_visual, template page, data { path: "${page}" }) and text the cover and the page's link.`,
    "Your reply is one line about the page, never the plain note's link.",
    "",
    PAGE_SKILL,
  ].join("\n");
}
