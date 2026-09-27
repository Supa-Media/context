/**
 * What a search result shows: a hit's title and the lines quoted from it, cut
 * from a fresh read of the note — never from index data.
 *
 * Both read the note's own words: comment anchors and comment threads
 * (`comments.cjs`) are removed first, so a comment on the heading never titles
 * a hit with its markers and a reply is never quoted as if the note said it.
 */

import comments from "../../../../packages/shared/src/comments.cjs";
import { termsOf } from "./text.js";

/** A note's own `#` heading, or its filename when it has none. */
export function noteTitle(path, text) {
  const heading = comments.stripComments(String(text)).split("\n").find((line) => /^#{1,6}\s+\S/.test(line));
  if (heading) return heading.replace(/^#{1,6}\s+/, "").trim().slice(0, 200);
  return path.split("/").pop().replace(/\.md$/, "");
}

/** Lines of a freshly read note that actually carry one of the matched terms. */
export function snippetLinesFor(text, matchedTerms) {
  const wanted = new Set(matchedTerms || []);
  if (wanted.size === 0) return [];
  const lines = [];
  for (const line of comments.stripComments(String(text)).split("\n")) {
    if (!line.trim()) continue;
    if (!termsOf(line).some((term) => wanted.has(term))) continue;
    lines.push(line.trim().slice(0, 200));
    if (lines.length === 3) break;
  }
  return lines;
}
