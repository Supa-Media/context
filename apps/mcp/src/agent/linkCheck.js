/**
 * A NOTE LINK TEX TEXTS IS ONE A TOOL GAVE IT (owner's report, 2026-11-03).
 *
 * In a group chat Tex saved a seven-day write-up as
 * `tex/groups/kite-willow-rocket/last-7-days-oct-27-to-nov-3.page.md`, then
 * texted `context.lc/note/@supa/tex/groups/kite-willow-rocket/last-7-days.page.md`.
 * No note was ever at that path, so the link opened "That file does not
 * exist". The write's own answer carried the right link (`noteLinks.js`), and
 * the prompt says to send only a link read in a tool result; the model
 * shortened the name anyway.
 *
 * So the answer's links to this deployment's notes are checked against what
 * the turn has seen: links and note paths in its tool results (a write's
 * `written:` line, a read's `path:` line, a link inside a note it read), the
 * texts it answered and the chat's earlier texts. A link to anything else
 * sends the model one more round, once, naming the links it does have. The
 * gateway never rewrites the link itself: a guessed fix is still a guess.
 */

import { noteLinkUrl, sentNoteLinks } from "./noteLinks.js";

/** Plenty for one answer; a reply is a few lines. */
const MAX_CHECKED = 20;
/** At most this many known links are named back to the model. */
const MAX_NAMED = 8;

const WRITTEN = /^written: (.+?) \(etag /gm;
const READ_PATH = /^path: ([^\n]+)$/gm;

const fold = (path) => String(path ?? "").trim().replace(/^\/+/, "").toLowerCase();

/**
 * The watcher for one turn's links: `see` every text the turn read or was
 * given, then `unknown(answer)` lists the answer's note links nothing backs.
 * With no https origin there are no note links to check.
 */
export function noteLinkCheck({ origin = null, question = "", history = [] } = {}) {
  const links = new Map(); // "slug\npath", folded → the link as a tool gave it
  const paths = new Set(); // note paths a tool answered with, folded, in whichever context
  const see = (text) => {
    if (origin === null || typeof text !== "string" || text === "") return;
    for (const link of sentNoteLinks(text, origin, { limit: Infinity })) {
      links.set(`${link.slug.toLowerCase()}\n${fold(link.path)}`, link);
    }
    for (const [, path] of text.matchAll(WRITTEN)) paths.add(fold(path));
    for (const [, path] of text.matchAll(READ_PATH)) paths.add(fold(path));
  };
  see(typeof question === "string" ? question : "");
  for (const turn of Array.isArray(history) ? history : []) see(turn?.text);
  return {
    /** A tool's result, every text block of it. */
    read(result) {
      for (const part of Array.isArray(result?.content) ? result.content : []) see(part?.text);
    },
    /** The answer's note links that no tool result, earlier text or their own text gave. */
    unknown(answer) {
      if (origin === null) return [];
      // A path a tool named backs a link only when no tool gave that path's link in another workspace: the same
      // path in the wrong workspace opens "That file does not exist" too (2026-11-03, @seyi for @public-worship).
      const elsewhere = (link) => [...links.values()].some((known) => fold(known.path) === fold(link.path) && known.slug.toLowerCase() !== link.slug.toLowerCase());
      return sentNoteLinks(String(answer ?? ""), origin, { limit: MAX_CHECKED }).filter(
        (link) => !links.has(`${link.slug.toLowerCase()}\n${fold(link.path)}`) && (!paths.has(fold(link.path)) || elsewhere(link)),
      );
    },
    /** The links the turn does have, newest last, as their addresses, for the notice. */
    known() {
      return [...links.values()].slice(-MAX_NAMED).map((link) => noteLinkUrl(origin, link.slug, link.path));
    },
  };
}

/** What Tex is told when its answer links to a note nothing gave it. */
export function unknownLinkNotice(unknown, known = []) {
  const named = unknown.map((link) => `@${link.slug}/${link.path}`).join(", ");
  const have = known.length === 0 ? "" : ` The note links you were given: ${known.join(" ")}`;
  return (
    `Before this goes: your answer links to ${named}, but no tool gave you that link, so it may open "That file does not exist". ` +
    "Copy a note's link exactly as the link: line of write or fetch gave it, never shortened or retyped; if you have none for it, read the note to get it." +
    have +
    "\nThen send your answer again with only links you were given."
  );
}
