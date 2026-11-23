/**
 * `read_note` for part of a note: its outline, one section, or a range of lines
 * (decided by the owner, 2026-11-23; `docs/decisions/gateway-protocol/section-reads.md`).
 *
 * It reads the note through `toolReadNote`, unchanged, and only then cuts the
 * answer. So who may read the note, what a refusal costs and which text is
 * current (the live collaboration text when somebody is typing) are decided
 * exactly as for a whole read, and a refusal says nothing about headings.
 *
 * Only the `read_note` tool reaches this. The gateway's own readers (comments,
 * remember, mail, meeting summaries) call `toolReadNote` and always get the
 * whole note, because they edit it and save it back.
 *
 * A part's etag ends in `;part` (`PARTIAL_ETAG_SUFFIX`), so a whole-note save
 * made from it is refused (`tools/partialEtag.js`).
 */

import { toolError, toolText } from "../results.js";
import { toolReadNote } from "./read.js";
import { PART_CHARS, findSection, noteStructure, parseLines, renderOutline, sliceLines } from "../../notes/sections.js";
import { partialEtag } from "../partialEtag.js";

/** The `read_note` arguments that ask for part of a note. */
export const PART_ARGS = ["outline", "section", "lines"];

export function wantsPart(args) {
  return PART_ARGS.some((key) => args?.[key] !== undefined && args[key] !== false && args[key] !== null);
}

export async function toolReadNotePart(store, scope, rules, overrides, args) {
  const asked = PART_ARGS.filter((key) => args[key] !== undefined && args[key] !== false && args[key] !== null);
  if (asked.length > 1) return toolError(`pass one of ${asked.join(", ")}, not ${asked.length}: call it again with only the one you need.`);
  const whole = await toolReadNote(store, scope, rules, overrides, args.path);
  if (whole.isError) return whole;
  const cut = cuttable(whole);
  if (cut.error) return toolError(cut.error);
  const { marked, structure, total } = cut;
  const header = marked();

  if (asked[0] === "outline") {
    const depth = typeof args.outline === "object" ? args.outline.depth : undefined;
    const outline = renderOutline(structure, { depth });
    const cut = sliceLines(outline.split("\n"), 1, outline.split("\n").length);
    const shortened = cut.next === null ? "" : "\n…(outline cut; outline: { depth: 1 } lists fewer headings)";
    return answer(
      `${header}\npart: outline of ${total} lines`,
      `${cut.text}${shortened}\n\n` +
        `Read one: section: "<heading>" or section: <line>, or lines: "<a>-<b>"; the whole note: without outline.`,
      whole,
    );
  }

  let range;
  let label;
  let partHeader = header;
  if (asked[0] === "section") {
    const found = findSection(structure, args.section);
    if (found.error) return toolError(found.error);
    range = { start: found.start, end: found.end };
    label = `section "${found.heading.text || found.heading.anchor}", `;
    // The section's hash rides on its etag, so writing it back still lands after an edit elsewhere in the note.
    partHeader = marked(structure.lines.slice(found.start - 1, found.end).join("\n"));
  } else {
    const parsed = parseLines(args.lines, total);
    if (parsed.error) return toolError(parsed.error);
    range = parsed;
    label = "";
  }
  const part = sliceLines(structure.lines, range.start, range.end, PART_CHARS);
  const more =
    part.next === null
      ? ""
      : `\nmore: lines: "${part.next}-${range.end}" (in place of section or lines) reads on; those lines are not shown here`;
  return answer(`${partHeader}\npart: ${label}lines ${part.start}-${part.end} of ${total}${more}`, part.text, whole);
}

/**
 * A whole read's answer, ready to cut: its header with the etag marked as a part's, and the body's structure. Or the
 * reason it cannot be cut (a drawing, an encrypted note, or an answer that is not header and body).
 */
export function cuttable(whole) {
  const opened = whole.opened;
  const full = whole.content?.[0]?.text ?? "";
  if (!opened || typeof opened.text !== "string" || /^kind: drawing$/m.test(headerOf(full))) {
    return { error: "this note is a drawing, which has no sections: read it without outline, section or lines." };
  }
  if (opened.encrypted) return { error: "an encrypted note is read whole: call it again without outline, section or lines." };
  const body = opened.text;
  if (!full.endsWith(body)) return { error: "this note could not be cut into parts right now: read it whole, without outline, section or lines." };
  const headerOfWhole = full.slice(0, full.length - body.length).replace(/\n\n$/, "");
  const marked = (sectionText = null) => headerOfWhole.replace(/^etag: (\S+)$/m, (_, etag) => `etag: ${partialEtag(etag, sectionText)}`);
  const structure = noteStructure(body);
  return { marked, structure, total: structure.lines.length, body, path: opened.path };
}

function headerOf(text) {
  const cut = text.indexOf("\n\n");
  return cut === -1 ? text : text.slice(0, cut);
}

/** The answer, keeping the whole read's `opened` (its path and note id place the etag; `etagPlace.js`). */
export function answer(header, body, whole) {
  const result = toolText(`${header}\n\n${body}`);
  return Object.defineProperty(result, "opened", { value: whole.opened, enumerable: false });
}
