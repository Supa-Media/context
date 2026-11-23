/**
 * `write_note` for part of a note: one section replaced, added to at its end
 * or start, or find-and-replace edits (decided by the owner, 2026-11-23;
 * `docs/decisions/gateway-protocol/section-reads.md`).
 *
 * The agent sends a part; the gateway builds the whole new text from the note
 * as it stands and saves it through `toolWriteNote` like any whole save, so
 * privacy, history, audit and the collaboration merge stay one route.
 *
 * What guards each kind:
 *
 *  - **Replacing a section** overwrites lines the agent may not have read, so it
 *    takes the etag its section read gave. If the note changed since, it still
 *    lands when that section's own text is unchanged (the hash on the etag,
 *    `partialEtag.js`); otherwise it is refused with only that section as it is now.
 *  - **Appending or prepending** to a section, and **edits**, need no etag (the
 *    owner's choice, 2026-11-23): an edit's `old` must occur exactly once, so an
 *    edit made stale by somebody else's change simply finds nothing and changes
 *    nothing, as Claude Code's `Edit` does.
 *  - Nothing may reach a note's machine blocks (its comments and mail), or take
 *    out a comment's anchor, so a part write can never lose a thread.
 */

import { toolError } from "../results.js";
import { toolReadNote } from "./read.js";
import { toolWriteNote } from "./write.js";
import { findSection, noteStructure } from "../../notes/sections.js";
import { textHash } from "../partialEtag.js";

/** At most this many edits in one call. */
export const MAX_EDITS = 20;

const INSERTS = new Set(["replace", "append", "prepend"]);
const COMMENT_ANCHOR = /<!--\/?c:[A-Za-z0-9_-]+-->/g;

export function writesPart(args) {
  return args?.section !== undefined || args?.edits !== undefined;
}

export async function toolWriteNotePart(store, scope, rules, overrides, args, options = {}) {
  const shape = checkShape(args);
  if (shape) return toolError(shape);
  // The note as a whole read gives it to this caller: the same privacy check, the live text while somebody types.
  const read = await toolReadNote(store, scope, rules, overrides, args.path);
  if (read.isError) return read;
  const opened = read.opened;
  if (!opened || typeof opened.text !== "string") return toolError("this note cannot be changed in parts: write it whole.");
  if (opened.encrypted) return toolError("an encrypted note is changed whole: read it and write the whole note.");
  if (/^kind: drawing$/m.test(read.content?.[0]?.text ?? "")) return toolError("a drawing has no sections: open it in the app to change it, then try again.");
  const current = /^etag: (\S+)$/m.exec(read.content?.[0]?.text ?? "")?.[1];
  const before = opened.text;
  const built = args.edits !== undefined ? applyEdits(before, args) : replaceSection(before, args, current);
  if (built.error) return toolError(built.error);
  if (built.text === before) return toolError("nothing would change: the note already says that. Nothing was written; read it again before you change it.");
  const commentsBefore = (before.match(COMMENT_ANCHOR) ?? []).length;
  if ((built.text.match(COMMENT_ANCHOR) ?? []).length < commentsBefore) {
    return toolError("refused: this would take out a comment's anchor (<!--c:…-->) and leave its thread hanging. Nothing was written; keep the markers, or resolve the comment first.");
  }
  const { section, insert, edits, expected_etag: _read, expected_part_hash: _hash, ...rest } = args;
  const written = await toolWriteNote(store, scope, rules, overrides, { ...rest, content: built.text, expected_etag: current }, options);
  if (written.isError && /^conflict/.test(written.content?.[0]?.text ?? "")) {
    // Somebody saved between the read above and this write. The conflict answer carries the whole note; this is a part.
    return toolError("conflict: the note changed while this was being saved. Nothing was written; call it again.");
  }
  return written;
}

function checkShape(args) {
  if (args.section !== undefined && args.edits !== undefined && args.insert !== undefined) {
    return "edits take no insert: pass section with insert, or edits (with section to look only there), not all three.";
  }
  if (args.edits !== undefined) {
    if (!Array.isArray(args.edits) || args.edits.length === 0) return "edits is a list of { old, new }: pass at least one.";
    if (args.edits.length > MAX_EDITS) return `at most ${MAX_EDITS} edits in one call: split them into smaller calls.`;
    for (const [at, edit] of args.edits.entries()) {
      if (!edit || typeof edit.old !== "string" || typeof edit.new !== "string") return `edit ${at + 1} needs old and new, both text.`;
      if (edit.old === "") return `edit ${at + 1} has an empty old: name the exact words to change. To add text, use section with insert: "append".`;
    }
    if (args.content !== undefined) return "edits carry their own text: leave content out.";
    return null;
  }
  if (typeof args.content !== "string") return "content is the section's new text: pass it with section.";
  if (args.insert !== undefined && !INSERTS.has(args.insert)) return 'insert is "replace" (the default), "append" or "prepend".';
  return null;
}

/** The section a write names, as lines `start..end`, from the note's current text. */
function sectionOf(structure, query) {
  const found = findSection(structure, query);
  if (found.error) return { error: found.error };
  return found;
}

function replaceSection(text, args, currentEtag) {
  const structure = noteStructure(text);
  const found = sectionOf(structure, args.section);
  if (found.error) return found;
  const { lines } = structure;
  const own = lines.slice(found.start - 1, found.end);
  const insert = args.insert ?? "replace";
  const content = args.content.replace(/\n+$/, "");
  if (insert === "replace") {
    // A replace overwrites lines: it needs the version that was read, or that section unchanged since.
    const stale = typeof args.expected_etag !== "string" || args.expected_etag !== bareVersion(currentEtag);
    if (stale) {
      const unchanged = typeof args.expected_part_hash === "string" && args.expected_part_hash === textHash(own.join("\n"));
      if (!unchanged) {
        const why = typeof args.expected_etag !== "string" ? "replacing a section needs the etag its section read gave" : "this section changed since you read it";
        return { error: `conflict: ${why}. Nothing was written; read the section again, then write it back with the etag that read gives. The section as it is now:\n\n${own.join("\n")}` };
      }
    }
    return { text: [...lines.slice(0, found.start - 1), content, ...lines.slice(found.end)].join("\n") };
  }
  if (insert === "append") return { text: [...lines.slice(0, found.end), content, ...lines.slice(found.end)].join("\n") };
  return { text: [...lines.slice(0, found.start), content, ...lines.slice(found.start)].join("\n") };
}

/** The version an etag names, without its place (`@name/id:`), as `toolReadNote`'s header gives it. */
function bareVersion(etag) {
  return typeof etag === "string" ? etag.replace(/^@[a-z0-9][a-z0-9-]*(?:\/[A-Za-z0-9_-]+)?:/s, "") : etag;
}

function applyEdits(text, args) {
  const structure = noteStructure(text);
  // Where edits may look: one section when named, else the note up to its machine blocks.
  let start = 0;
  let end = text.length;
  if (args.section !== undefined) {
    const found = sectionOf(structure, args.section);
    if (found.error) return found;
    start = offsetOfLine(structure.lines, found.start);
    end = offsetOfLine(structure.lines, found.end + 1) - (found.end < structure.lines.length ? 1 : 0);
  } else if (structure.machineStart !== null) {
    end = offsetOfLine(structure.lines, structure.machineStart);
  }
  let region = text.slice(start, end);
  for (const [at, edit] of args.edits.entries()) {
    const found = occurrences(region, edit.old);
    const where = args.section !== undefined ? "in that section" : "in the note";
    if (found.length === 0) {
      return { error: `edit ${at + 1}: 0 matches for its old text ${where}. Nothing was written; read the part again and copy the words exactly.` };
    }
    if (found.length > 1 && edit.replace_all !== true) {
      const lines = found.slice(0, 10).map((index) => `L${lineAt(text, start + index)}`);
      return { error: `edit ${at + 1}: ${found.length} matches ${where}, at ${lines.join(", ")}. Nothing was written; add words around it so it matches once, or pass replace_all: true.` };
    }
    region = edit.replace_all === true ? region.split(edit.old).join(edit.new) : region.replace(edit.old, () => edit.new);
  }
  return { text: text.slice(0, start) + region + text.slice(end) };
}

function occurrences(haystack, needle) {
  const found = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

/** The character offset where 1-based `line` starts (the text's length past its last line). */
function offsetOfLine(lines, line) {
  let offset = 0;
  for (let at = 0; at < line - 1 && at < lines.length; at++) offset += lines[at].length + 1;
  return Math.min(offset, lines.join("\n").length);
}

function lineAt(text, offset) {
  let line = 1;
  for (let at = 0; at < offset; at++) if (text.charCodeAt(at) === 10) line++;
  return line;
}
