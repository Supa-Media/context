/**
 * The front page (`index.md`) and the save procedure it may carry: where
 * `orient`, the connect-time instructions and `save_context` read them.
 */

import { canSee, isPlumbing } from "../privacy/engine.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { normalizePath } from "../notes/paths.js";
import { SAVE_DESTINATION_LINE, SAVE_PROCEDURE_CHAR_CAP, SAVE_SECTION_HEADING } from "./render.js";

/**
 * The front page of a context, as its owner wrote it.
 *
 * `index.md` is an ordinary note at the bucket root — editable in Obsidian, in
 * any editor, or by an agent through `write_note`. It is deliberately not a
 * generated file: the derived structure below it is something we can always
 * rebuild, and the one thing we cannot is what the person considers important.
 */
export async function readFrontPage(store, scope, rules, overrides, charCap) {
  if (!canSee("index.md", scope, rules, overrides)) return null;
  const object = await getWithLegacyFallback(store, "index.md");
  if (!object) return null;
  const text = (await object.text()).trim();
  if (!text) return null;
  return text.length > charCap
    ? `${text.slice(0, charCap)}\n\n[truncated — read the whole thing with read_note("index.md")]`
    : text;
}

function extractSaveProcedure(indexText) {
  if (typeof indexText !== "string" || !indexText) return null;
  const lines = indexText.split(/\r?\n/);
  const start = lines.findIndex((line) => SAVE_SECTION_HEADING.test(line));
  if (start === -1) return null;
  const depth = lines[start].match(SAVE_SECTION_HEADING)[1].length;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s/);
    if (heading && heading[1].length <= depth) break;
    body.push(lines[index]);
  }

  let destination = null;
  const prose = [];
  for (const line of body) {
    const match = destination === null ? line.match(SAVE_DESTINATION_LINE) : null;
    // Only the first `destination:` counts. A second one is prose that happens
    // to look like a directive, and silently preferring the last would make the
    // meaning of the section depend on scrolling to the bottom of it.
    if (match) destination = match[1];
    else prose.push(line);
  }
  const text = prose.join("\n").trim();
  return {
    destination: normalizeSaveDestination(destination),
    text: text.length > SAVE_PROCEDURE_CHAR_CAP ? `${text.slice(0, SAVE_PROCEDURE_CHAR_CAP)}…` : text,
  };
}

/**
 * A folder path, or nothing.
 *
 * Rejected rather than repaired: a destination that does not survive
 * `normalizePath` is a typo in a file the person can see and fix, and quietly
 * writing their sessions somewhere adjacent to what they asked for is the worst
 * of the available outcomes. `.md` is refused because this names a folder —
 * appending to one note would collapse every session onto itself.
 */
function normalizeSaveDestination(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const cleaned = normalizePath(value.trim().replace(/^[`'"]|[`'"]$/g, "").replace(/\/+$/, ""));
  if (!cleaned || cleaned.endsWith(".md") || isPlumbing(`${cleaned}/x.md`)) return null;
  return cleaned;
}

export async function readSaveProcedure(store, scope, rules, overrides) {
  if (!canSee("index.md", scope, rules, overrides)) return null;
  const object = await getWithLegacyFallback(store, "index.md");
  if (!object) return null;
  return extractSaveProcedure(await object.text());
}
