/**
 * A model's `fetch` of a long note: its outline and first part, not the whole
 * of it (decided by the owner, 2026-11-23; `docs/decisions/gateway-protocol/section-reads.md`).
 *
 * Only a model's `fetch` is capped (`tools/session.js` passes `fetchCap` for a
 * v2 `fetch`, which is every external agent's read and Tex's). The gateway's and
 * Tex's own code read whole notes with `read_note`, because they compare or
 * save what they read, and `full: true` reads a note whole from a fetch too.
 *
 * - A note up to `PART_CHARS` is returned exactly as before.
 * - A longer note returns its outline and the lines from its start that fit,
 *   marked as a part (`;part`), with a `more:` line saying where to read on.
 * - A day of messages returns its outline alone: its threads with how many
 *   messages each holds, since its oldest messages are rarely the wanted ones
 *   and a search hit names its message directly.
 * - Several notes in one `notes:` read share one budget (`BATCH_CHARS`); a
 *   note past it comes back as its outline.
 */

import { isChannelDayNotePath } from "../../../../../packages/communications/src/paths.js";
import { PART_CHARS, approxTokens, renderOutline, sliceLines } from "../../notes/sections.js";
import { answer, cuttable } from "./readPart.js";

/** One `notes:` read's whole answer, across its notes. */
export const BATCH_CHARS = 64_000;

/** A note this short is returned whole even past a batch's budget: its outline would be no shorter. */
const SMALL_CHARS = 2_000;

/** The outline at the head of a capped read is at most this long. */
const OUTLINE_CHARS = 6_000;

/** `whole`, a successful whole read, as a model's fetch is given it. */
export function capWhole(whole, budget = PART_CHARS) {
  if (whole?.isError) return whole;
  const cut = cuttable(whole);
  // A drawing's description, an encrypted note or a chat history is returned as it came.
  if (cut.error) return whole;
  if (cut.body.length <= Math.max(budget, SMALL_CHARS)) return whole;
  const { marked, structure, total, path } = cut;
  const size = `~${Math.round(approxTokens(cut.body.length) / 100) / 10}k tokens`;
  const outlineLines = renderOutline(structure).split("\n");
  const outline = sliceLines(outlineLines, 1, outlineLines.length, OUTLINE_CHARS);
  const outlineText = `${outline.text}${outline.next === null ? "" : "\n…(outline cut; outline: { depth: 1 } lists fewer headings)"}`;
  if (isChannelDayNotePath(path) || budget < PART_CHARS) {
    return answer(
      `${marked()}\npart: outline of ${total} lines; the note is ${size}, too long to read whole`,
      `${outlineText}\n\nRead one: section: "<heading or msg-… anchor>", or lines: "<a>-<b>"; or full: true for all of it.`,
      whole,
    );
  }
  const room = Math.max(4_000, budget - outlineText.length);
  const part = sliceLines(structure.lines, 1, total, room);
  return answer(
    `${marked()}\npart: lines ${part.start}-${part.end} of ${total}; the note is ${size}, so its outline and first part are shown\n` +
      `more: lines: "${part.next}-${total}" reads on, section: "<heading>" reads one part, full: true reads it whole`,
    `Outline:\n${outlineText}\n\n---\n\n${part.text}`,
    whole,
  );
}

/** A `notes:` read's answer, its notes sharing one budget. Each note's own cap still applies. */
export function capBatch(result) {
  if (!Array.isArray(result?.content)) return result;
  const opened = new Map((result.notesOpened ?? []).filter(Boolean).map((note) => [note.path, note]));
  let used = 0;
  const content = result.content.map((part) => {
    const path = /^path: (.+)$/m.exec(part?.text ?? "")?.[1]?.trim();
    const note = path ? opened.get(path) : undefined;
    if (!note || part.text.startsWith("path:") /* an error part */) {
      used += part?.text?.length ?? 0;
      return part;
    }
    const single = Object.defineProperty({ content: [part] }, "opened", { value: note, enumerable: false });
    const left = BATCH_CHARS - used;
    const capped = capWhole(single, left < PART_CHARS ? Math.max(left, 0) : PART_CHARS);
    used += capped.content[0].text.length;
    return capped.content[0];
  });
  const out = { ...result, content };
  for (const key of ["notesOpened", "notesRead"]) {
    if (key in result) Object.defineProperty(out, key, { value: result[key], enumerable: false });
  }
  return out;
}
