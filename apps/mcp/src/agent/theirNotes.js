/**
 * A NOTE THEY ALREADY HAVE STAYS WHERE IT IS, AND AS IT IS (owner, 2026-10-30).
 *
 * "What is a .page? Why was my note completely overwritten, archived and
 * replaced with this ugly page?" Their chapter note `Areas/Bible/Joshua/
 * Joshua 1` was archived and a `Joshua 1.page.md` stood in its place. The
 * turn's page floor (`pageNotice.js`) had told Tex "write it again as a page,
 * then archive the plain note", and nothing between Tex and the dispatcher
 * asked whose note that plain one was.
 *
 * So a texted or group turn's dispatcher is wrapped here, and two calls are
 * answered instead of run unless their words ask for them:
 *
 *   - Archiving or moving a note this turn did not make: only when the
 *     question asks to archive, move, file, tidy, rename, delete or the like.
 *   - Creating `<name>.page.md` beside their own `<name>.md`, which is
 *     turning their note into a page: only when the question asks for a page.
 *
 * A note Tex made in this same turn is its own to move or archive: the page
 * floor's "archive the plain copy you just made" still works. Nothing is
 * refused for good: the answer says why and what to do instead. A routine's
 * run is not wrapped; its note is the standing ask.
 */

import { activityHintOf } from "../live/activityHint.js";

/** Their words ask for a note to be moved, filed, archived or cleared away. */
export const ASKS_TO_MOVE =
  /\b(?:archiv\w*|mov(?:e|es|ed|ing)|renam\w*|(?:re)?organi[sz]\w*|tid(?:y|ied|ying)|clean\w* up|clear\w* out|fil(?:e|ed|ing) (?:it|this|that|them|these|those|under|in|into|away)|sort\w*|put (?:it|this|that|them|these|those)|delet\w*|remov\w*|trash\w*|get rid|declutter\w*|merg\w*|combin\w*|replac\w*|put away|shift|relocat\w*)\b/i;

/** Their words ask for a page. */
export const ASKS_FOR_PAGE = /\bpages?\b/i;

const PAGE_SUFFIX = /\.page\.md$/i;

/** A path as compared here: no leading slash, case folded, keyed by the workspace it names. */
function keyOf(path, context) {
  const where = typeof context === "string" ? context.trim().toLowerCase() : "";
  return `${where}\n${String(path ?? "").trim().replace(/^\/+/, "").toLowerCase()}`;
}

/** The notes a moving or archiving call takes from where they are, by tool. */
export function notesTaken(name, args) {
  const call = args && typeof args === "object" ? args : {};
  const inner = call.args && typeof call.args === "object" ? call.args : call;
  const action = typeof call.action === "string" ? call.action : "";
  if (name === "archive_note" || (name === "manage" && action === "archive")) return [inner.path].filter(isText);
  if (name === "move_note" || (name === "manage" && action === "move")) return [inner.source ?? inner.path].filter(isText);
  if (name === "move_folder" || (name === "manage" && action === "move_folder")) return [inner.source].filter(isText);
  if (name === "move_notes" || (name === "manage" && action === "move_many")) {
    const moves = Array.isArray(inner.moves) ? inner.moves.map((move) => move?.source).filter(isText) : [];
    return moves.length > 0 ? moves : [inner.folder].filter(isText); // a `{ folder, match }` move takes from that folder
  }
  return [];
}

function isText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** The answer when a call would move or archive a note of theirs they did not ask about. */
export function keptInPlace(path) {
  return (
    `Not moved, and nothing failed: ${path} is their note, and they did not ask for it to be moved or archived. ` +
    "Leave it where it is. A change they asked for goes into that note itself: read it and write it with its etag, keeping its form and everything they did not ask to change."
  );
}

/** The answer when a new page would stand in for their plain note. */
export function keptAsItIs(plain, page) {
  return (
    `Not saved, and nothing failed: ${plain} is already their note, and ${page} would replace it with a page they did not ask for. ` +
    `Change ${plain} itself: read it and write it with its etag, in the same form. Make a page of it only when they ask for a page.`
  );
}

/** Whether a listing (`path (N bytes)` lines) names `path`. */
function listed(listing, path) {
  const want = path.toLowerCase();
  return String(listing ?? "")
    .split("\n")
    .some((line) => line.replace(/\s+\(\d[\d,]* bytes\)\s*$/, "").trim().toLowerCase() === want);
}

/**
 * Wraps a texted or group turn's dispatcher (`route.js`). `question` is the
 * text being answered; `on` is false for a routine's run. One per turn.
 */
export function withTheirNotesKept(callTool, { question = "", on = true } = {}) {
  if (!on) return callTool;
  const asked = String(question ?? "");
  const made = new Set();
  return async (name, args) => {
    const where = args?.context;
    const taken = notesTaken(name, args);
    if (taken.length > 0 && !ASKS_TO_MOVE.test(asked)) {
      const theirs = taken.find((path) => !made.has(keyOf(path, where)));
      if (theirs !== undefined) {
        console.log(JSON.stringify({ event: "their_note_kept", tool: name }));
        return { content: [{ type: "text", text: keptInPlace(theirs) }], isError: true };
      }
    }
    const saving = name === "write_note" || (name === "write" && (args?.action === undefined || args?.action === "" || args?.action === "save"));
    const path = saving && isText(args?.path) ? args.path.trim().replace(/^\/+/, "") : "";
    if (path !== "" && PAGE_SUFFIX.test(path) && args?.expected_etag === undefined && !ASKS_FOR_PAGE.test(asked)) {
      const plain = path.replace(PAGE_SUFFIX, ".md");
      if (!made.has(keyOf(plain, where))) {
        const cut = path.lastIndexOf("/");
        let theirs = false;
        try {
          const listing = await callTool("list_notes", { prefix: cut === -1 ? "" : `${path.slice(0, cut)}/`, ...(isText(where) ? { context: where } : {}) });
          theirs = listing?.isError !== true && listed(listing?.content?.[0]?.text, plain);
        } catch {
          // A listing that fails refuses nothing: the page is saved as asked.
        }
        if (theirs) {
          console.log(JSON.stringify({ event: "their_note_kept", tool: name }));
          return { content: [{ type: "text", text: keptAsItIs(plain, path) }], isError: true };
        }
      }
    }
    const result = await callTool(name, args);
    if (path !== "" && result?.isError !== true && activityHintOf(result)?.created === true) made.add(keyOf(path, where));
    return result;
  };
}
