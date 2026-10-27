/**
 * A NEW NOTE GOES WHERE THE PERSON'S FOLDERS SAY (Tex's self-review, 2026-10-24).
 *
 * Asked to put meeting notes "in thoughts and reflections", Tex saved them at
 * the top of Areas/Thoughts and Reflection/, beside the person's own
 * "2026 - Fall" subfolder, where every note of the term lived. They asked why
 * it had not seen that. The turn never listed the folder: it read the map,
 * which names folders, and wrote.
 *
 * So a texted create straight into a folder that also sorts notes into
 * subfolders is answered, once per path in the turn, with those subfolders
 * and asked to choose: the same write with a subfolder's path saves it there,
 * and the same path again saves it where it was asked for. Nothing is
 * refused for good, and a note that already exists, a top-level note, Tex's
 * own folder and a routine are never asked about. Context's own capture
 * folders (the Inbox's, Tex's) are not offered as places to file into.
 */

import { INBOX_PARTS, TEX_PARTS } from "../../../../packages/shared/src/folderJobInfo.cjs";
import { routineRootOf } from "../../../../packages/shared/src/routines.cjs";

/** Subfolder names that hold a note's pieces, not notes of their own. */
const NOT_PLACES = new Set([...INBOX_PARTS, ...TEX_PARTS, "attachments", "assets", "images", "files"]);

/** How many subfolders the question names. */
const SHOWN = 12;

/** The folder a note path sits in, or "" at the top. */
function parentOf(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** Whether a create at `path` is one to ask about at all. */
function askable(path) {
  if (typeof path !== "string" || !path.endsWith(".md")) return false;
  if (parentOf(path) === "") return false;
  if (routineRootOf(path) !== null) return false;
  // Tex's own folder files by its own rules (about-me, routines, groups).
  return !path.split("/").some((segment) => segment.toLowerCase() === "tex");
}

/**
 * The subfolders directly inside `folder`, each with how many notes it holds,
 * read from a recursive listing; and whether `path` is already a note there.
 */
export function folderShape(listing, folder, path) {
  const counts = new Map();
  let exists = false;
  for (const line of String(listing ?? "").split("\n")) {
    const key = line.replace(/\s+\(\d+ bytes\)$/, "").trim();
    if (key === path) exists = true;
    if (!key.startsWith(`${folder}/`)) continue;
    const rest = key.slice(folder.length + 1);
    const cut = rest.indexOf("/");
    if (cut === -1) continue;
    const name = rest.slice(0, cut);
    if (name.startsWith(".") || name.startsWith("_") || NOT_PLACES.has(name.toLowerCase())) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return { exists, subfolders: [...counts].map(([name, notes]) => ({ name, notes })) };
}

/** The answer that asks Tex to choose, naming the subfolders. */
export function folderFitAsk(folder, subfolders) {
  const named = subfolders
    .slice(0, SHOWN)
    .map(({ name, notes }) => `${name} (${notes} note${notes === 1 ? "" : "s"})`)
    .join(", ");
  const more = subfolders.length > SHOWN ? `, and ${subfolders.length - SHOWN} more` : "";
  return (
    `Not saved yet, and nothing failed: ${folder}/ keeps its notes in subfolders: ${named}${more}. ` +
    "Call write_note again with the path in the one this note belongs in (by its date, the current term or year; or by its topic). " +
    "If none of them fits, call write_note again with this same path and it saves. Don't ask them which."
  );
}

/**
 * Wraps a texting turn's dispatcher: a `write_note` creating a note straight
 * into a folder with subfolders is answered with `folderFitAsk` the first time
 * that path is asked for in this turn. One wrapper per turn.
 */
export function withFolderFit(callTool) {
  const asked = new Set();
  return async (name, args) => {
    if (name !== "write_note" || args?.expected_etag !== undefined || args?.action !== undefined || !askable(args?.path)) {
      return callTool(name, args);
    }
    const where = typeof args.context === "string" ? args.context : "";
    const key = `${where}\n${args.path}`;
    if (asked.has(key)) return callTool(name, args);
    asked.add(key);
    const folder = parentOf(args.path);
    let shape = null;
    try {
      const listed = await callTool("list_notes", { prefix: `${folder}/`, ...(where ? { context: where } : {}) });
      if (listed?.isError !== true) shape = folderShape(listed?.content?.[0]?.text, folder, args.path);
    } catch {
      // A listing that fails asks nothing: the note is saved where it was asked for.
    }
    if (shape === null || shape.exists || shape.subfolders.length === 0) return callTool(name, args);
    console.log(JSON.stringify({ event: "folder_fit_asked", subfolders: shape.subfolders.length }));
    return { content: [{ type: "text", text: folderFitAsk(folder, shape.subfolders) }], isError: true };
  };
}
