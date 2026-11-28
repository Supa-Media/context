/**
 * `named_alike`: the other notes beside a note, in its own folder, whose names share a word with its own. A group
 * chat's Tex is handed them as a fact on every `read_note` (`session.js` sets `namedAlike` for the group client), so
 * when someone says "share the setlist" and three setlists sit side by side, the note it opened is never the only one
 * it knows of (Lab, 2026-11-28: Tex opened the setlist it remembered and posted it, with two newer ones beside it).
 * What to do with several is Tex's own rule (`texPrompt/rules.md`: name your best guess and ask). Names only: a
 * listing at the caller's own scope, so nothing it could not already list is named.
 */

import { listVisibleNoteKeys } from "../../notes/visibleKeys.js";
import { isTextFilePath } from "../../../../../packages/shared/src/fileKinds.cjs";

/** The header key the fact is given under. */
export const NAMED_ALIKE = "named_alike";
/** At most this many names, so a crowded folder costs a line, not a listing. */
const MAX_ALIKE = 8;
/** Words too short to say two names are alike. */
const MIN_WORD = 3;

const folderOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path) => path.slice(path.lastIndexOf("/") + 1);

/** A file name's words, lowercased, every extension dropped (`plan.page.md` is `plan`). */
export function nameWords(path) {
  const name = baseOf(path).replace(/\..*$/, "");
  return new Set(name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= MIN_WORD));
}

/** The file names among `paths` beside `path` (same folder, not itself) sharing a name word with it, sorted. */
export function namesAlike(path, paths) {
  const words = nameWords(path);
  if (words.size === 0) return [];
  const folder = folderOf(path);
  const alike = new Set();
  for (const other of paths) {
    if (typeof other !== "string" || other === path || folderOf(other) !== folder) continue;
    if ([...nameWords(other)].some((word) => words.has(word))) alike.add(baseOf(other));
  }
  return [...alike].sort().slice(0, MAX_ALIKE);
}

/** A `read_note` answer with `named_alike: a, b` put in its header, before its body. Unchanged with none, or on a refusal. */
export function withNamedAlike(result, names) {
  if (result?.isError === true || names.length === 0) return result;
  const parts = Array.isArray(result?.content) ? result.content : [];
  const first = parts[0];
  if (typeof first?.text !== "string") return result;
  const cut = first.text.indexOf("\n\n");
  const head = cut < 0 ? first.text : first.text.slice(0, cut);
  const rest = cut < 0 ? "" : first.text.slice(cut);
  // A second listing (a Lab test chat's own notes, `sandboxTools.js`) joins the line already there.
  const held = new RegExp(`^${NAMED_ALIKE}: (.*)$`, "m").exec(head);
  const all = [...new Set([...(held ? held[1].split(", ") : []), ...names])].sort().slice(0, MAX_ALIKE);
  const line = `${NAMED_ALIKE}: ${all.join(", ")}`;
  const text = `${held ? head.replace(held[0], line) : `${head}\n${line}`}${rest}`;
  return { ...result, content: [{ ...first, text }, ...parts.slice(1)] };
}

/** The path a `read_note` answer says it read (`path:` in its header), or null. */
export function readPathOf(result) {
  const text = result?.content?.[0]?.text;
  return typeof text === "string" ? (/^path: ([^\n]+)$/m.exec(text.split("\n\n")[0])?.[1] ?? null) : null;
}

/** `read_note`'s answer with the notes named like it beside it, listed at the caller's scope. */
export async function readWithNamedAlike(result, store, scope, rules, overrides) {
  const path = readPathOf(result);
  if (path === null || result?.isError === true) return result;
  const folder = folderOf(path);
  // A note at the top has the whole context beside it: no listing of everything for one line.
  if (folder === "") return result;
  let keys;
  try {
    keys = await listVisibleNoteKeys(store, scope, rules, overrides, folder, isTextFilePath);
  } catch {
    // A listing that fails costs the fact, never the read.
    return result;
  }
  return withNamedAlike(result, namesAlike(path, keys.map(({ key }) => key)));
}
