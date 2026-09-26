import { PROPERTY_NAME } from "./grammar.js";
import { noteProperties } from "./properties.js";

/**
 * One frontmatter property of a note, changed in its text — the write half of
 * `noteProperties`, for a list that edits a status or an owner in place.
 *
 * ## It changes one line and nothing else
 *
 * The note is somebody's file. Every byte outside the property's own line (or
 * its block list) stays exactly as it was: other keys, comments, their order,
 * the line endings, a byte-order mark, the body. A property that is not there
 * is added as the last line of the frontmatter; a note with no frontmatter
 * gets one. Setting `null` removes the property.
 *
 * ## It refuses rather than guesses
 *
 * Same discipline as the list grammar. A key that is not a property name, a
 * value with a line break or a control character, a value holding both kinds
 * of quote (which the reader has no escape for), and a frontmatter that is
 * never closed are all refused with a reason, and the text is not touched.
 * Whatever this writes, `noteProperties` reads back as the value given — the
 * check at the end holds that, so a surprise in somebody's frontmatter comes
 * back as an error, never as a quietly different note.
 *
 * `setNoteProperty(text, key, value)` → `{ text }` or `{ error }`.
 */
export function setNoteProperty(text, key, value) {
  if (typeof text !== "string") return { error: "there is no note to change" };
  if (typeof key !== "string" || !PROPERTY_NAME.test(key)) return { error: `"${key}" is not a property name` };
  let written = null;
  if (value !== null) {
    if (typeof value !== "string") return { error: "a property takes text" };
    const trimmed = value.trim();
    if (trimmed === "") return { error: "a property needs a value; clear it instead" };
    // Any control character, line breaks included: a value is one line.
    if (/\p{Cc}/u.test(trimmed)) return { error: "a property is one line of text" };
    // The reader drops " #…" as a comment before it looks for quotes.
    if (/\s#/.test(trimmed)) return { error: 'a value cannot hold " #", which reads as a comment' };
    written = quoted(trimmed);
    if (written === null) return { error: "a value cannot hold both kinds of quote" };
  }

  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = text.slice(bom.length);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const line = written === null ? null : `${key}: ${written}`;

  let next;
  if (!/^---\s*$/.test(lines[0] ?? "") || lines.length < 2) {
    if (line === null) return { text };
    next = ["---", line, "---", ...(source === "" ? [""] : ["", ...lines])];
  } else {
    const close = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
    if (close === -1) return { error: "this note's frontmatter is never closed" };
    const at = lastKeyLine(lines, close, key);
    if (at === -1) {
      if (line === null) return { text };
      next = [...lines.slice(0, close), line, ...lines.slice(close)];
    } else {
      let end = at + 1;
      while (end < close && (/^\s/.test(lines[end]) || /^-\s/.test(lines[end])) && lines[end].trim() !== "") end++;
      next = [...lines.slice(0, at), ...(line === null ? [] : [line]), ...lines.slice(end)];
    }
  }

  const result = bom + next.join(eol);
  const back = noteProperties(result)[key];
  if (value === null ? back !== undefined : back !== value.trim()) {
    return { error: "this note's frontmatter could not be changed safely" };
  }
  return { text: result };
}

/** The line index of the last top-level `key:` before `close`, or -1. */
function lastKeyLine(lines, close, key) {
  let found = -1;
  for (let i = 1; i < close; i++) {
    const keyed = /^([^:#\s][^:]*?)\s*:(?:\s|$)/.exec(lines[i]);
    if (keyed && keyed[1] === key) found = i;
  }
  return found;
}

/**
 * A value as the reader will read it back: bare when it is plainly text,
 * otherwise in whichever quote it does not contain.
 *
 * `true`, `false` and a plain number are written bare too. Somebody typing
 * `false` into a `draft` property means false, and a website page's `draft`
 * and `nav` are only accepted bare — `draft: "false"` is a page with a
 * problem. Words YAML 1.1 would quietly turn into a boolean or a null (`yes`,
 * `off`, `~`), a capitalised `True`, and a number with a leading zero or a
 * sign are still quoted, because there the person almost certainly meant the
 * text.
 */
function quoted(value) {
  const scalar = /^(true|false|(0|[1-9]\d*)(\.\d+)?)$/.test(value);
  const plain =
    scalar ||
    (/^[^\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
      !/:\s|:$/.test(value) &&
      !/^(true|false|yes|no|null|on|off|~|[-+]?[\d.]+)$/i.test(value));
  if (plain) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return null;
}
