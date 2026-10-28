/**
 * WHAT THE SHARING JUDGE IS TOLD THE CALL ACTS ON (the owner, 2026-10-28).
 *
 * The judge saw the person's words and "make projects/ops/sync.md visible to
 * the team", and refused "make the coordination channel visible to the team",
 * because nothing told it that the note is the coordination channel. The
 * person's instruction should be enough without asking again.
 *
 * So it is also shown, for the one note or folder the call names, its path
 * and its title (front matter `title`, else its first heading) from the tree's
 * facts: never its body, never anything else in the workspace. The title is
 * someone's text, so it is cut to one short line and fenced as data by the
 * judge (`judge.js`), and the audience is still judged from the words alone.
 */

import { factProps } from "../tree/facts.js";
import { normalizePath } from "../notes/paths.js";
import { oneLine } from "./egress.js";

/** A title is a name, not a paragraph. */
const MAX_TITLE = 80;

/** The arguments that name what a widening call acts on, first found wins. */
const SUBJECT_ARGUMENTS = ["path", "source", "note"];

/**
 * `{ path, title? }` for the note or folder `args` names, or null. Never
 * throws: a subject the facts cannot name is judged by its path alone.
 */
export async function judgeSubject(store, args) {
  const named = SUBJECT_ARGUMENTS.map((key) => args?.[key]).find((value) => typeof value === "string" && value !== "");
  const path = named === undefined ? null : normalizePath(named);
  if (!path) return null;
  if (!path.endsWith(".md")) return { path };
  try {
    const props = (await factProps(store, [path]))?.get(path)?.props;
    const title = typeof props?.properties?.title === "string" ? props.properties.title : props?.heading;
    const line = typeof title === "string" ? oneLine(title).slice(0, MAX_TITLE) : "";
    return line ? { path, title: line } : { path };
  } catch {
    return { path };
  }
}
