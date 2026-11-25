/**
 * A project's `area:` line follows its area when the area's folder moves
 * (`docs/decisions/app-and-console/areas-as-seats.md`, "A project serves an area").
 *
 * The line names a folder, `area: areas/finance`, not a note, so the link
 * rewrite does not see it. It is still a reference, and the rule for those is
 * the same: it follows what it points at. Without this, renaming an area takes
 * every project off it without a word.
 *
 * An area is followed when its front note moved and kept its name
 * (`areas/finance/about.md` to `areas/money/about.md`). That is what a folder
 * move or rename does. Moving one note out of the folder is not moving the
 * area, so nothing else counts. An area folder with no front note is not
 * followed.
 *
 * Text in, text out, shared by both move engines: the gateway's
 * (`tools/moves/references.js`) and the control plane's
 * (`apps/convex/functions/lib/fileOps/references.ts`).
 */

import { FRONT_NOTES } from "../lists/grammar.js";

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const AREA_LINE = /^(area[ \t]*:[ \t]*)(["']?)([^"'\r\n#]*?)\2([ \t]*(?:#.*)?)$/m;

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

/** Whether `renames` moved any front note, so the front notes elsewhere may hold an `area:` line to follow. */
export function movesAFrontNote(renames) {
  for (const from of renames.keys()) if (FRONT_NOTES.includes(baseName(from))) return true;
  return false;
}

/** The front notes among `keys` an `area:` line can be in: read beside the link candidates when an area may have moved. */
export function areaLineCandidates(keys, renames) {
  if (!movesAFrontNote(renames)) return [];
  return keys.filter((key) => FRONT_NOTES.includes(baseName(key)));
}

/** Where the folder `folder` went, if its front note moved with its name; otherwise null. */
function folderMovedTo(folder, renames) {
  for (const name of FRONT_NOTES) {
    const to = renames.get(`${folder}/${name}`);
    if (typeof to === "string" && to.endsWith(`/${name}`)) {
      const moved = to.slice(0, -(name.length + 1));
      return moved !== folder && moved !== "" ? { folder: moved, note: to } : null;
    }
  }
  return null;
}

/**
 * `text` with its front matter's `area:` line pointed at where its area went, or null when there is nothing to
 * change. `allow(destination)` is the referrer's privacy check on the area's moved front note: a line is never
 * pointed somewhere the note's own readers could not go (the link rewrite's rule).
 *
 * @param {string} text
 * @param {ReadonlyMap<string, string>} renames
 * @param {(destination: string) => boolean} [allow]
 * @returns {{ text: string, changed: number } | null}
 */
export function followAreaLine(text, renames, allow = () => true) {
  if (typeof text !== "string" || renames.size === 0) return null;
  const block = FRONT_MATTER.exec(text);
  if (block === null) return null;
  const line = AREA_LINE.exec(block[1]);
  if (line === null) return null;
  const [whole, lead, quote, value, tail] = line;
  const folder = value.trim().replace(/^\/+|\/+$/g, "");
  if (folder === "" || /^(true|false)$/i.test(folder)) return null;
  const moved = folderMovedTo(folder, renames);
  if (moved === null || !allow(moved.note)) return null;
  const start = block.index + block[0].indexOf(block[1]) + line.index;
  const replaced = `${lead}${quote}${moved.folder}${quote}${tail}`;
  return { text: text.slice(0, start) + replaced + text.slice(start + whole.length), changed: 1 };
}

/** A link rewrite's result (`rewriteLinks`) with the `area:` line followed on top; null when neither changed. */
export function withAreaLine(rewritten, text, renames, allow) {
  const area = followAreaLine(rewritten?.text ?? text, renames, allow);
  if (area === null) return rewritten;
  return { ...(rewritten ?? {}), text: area.text, changed: (rewritten?.changed ?? 0) + area.changed };
}
