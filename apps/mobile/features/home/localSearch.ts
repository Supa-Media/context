import { isDrawingPath } from "@context/drawings";
import type { SearchAnswer } from "../console/files/browser";
import { noteHeading, splitNote } from "../console/files/frontmatter";

/**
 * Search over the homepage's notes, which are all in the tab.
 *
 * The homepage is the console's own frame over notes held in memory
 * (`useLocalFileBrowser`), so the console's search answers there the way it
 * answers in a workspace: a hit is a note, named by its title, with the line
 * that matched. Nothing is asked of a server, because there is nothing behind
 * this page to ask — and the answer is complete, which is why it never says
 * the index is missing or behind.
 *
 * Titles first, then bodies, each in the tree's order: somebody typing
 * `pricing` means the page called Pricing before the page that mentions it.
 */

/** Characters either side of the match a snippet keeps. */
const SNIPPET_REACH = 36;

const HEADING = /^#{1,6}\s+/;
/** List, quote and emphasis syntax, which is how the line is written rather than what it says. */
const LINE_SYNTAX = /^\s*(?:[-*+]\s+|\d+\.\s+|>\s*)+/;
/** Comment anchors and other HTML comments: markers in the file, never words on the page. */
const COMMENTS = /<!--[\s\S]*?-->/g;

/** The words of one line, without the syntax that writes them. */
function plainLine(line: string): string {
  return line
    .replace(COMMENTS, "")
    .replace(HEADING, "")
    .replace(LINE_SYNTAX, "")
    .replace(/[*_`]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The matching part of the first line that contains `needle`, trimmed to a
 * window around it with an ellipsis where it was cut. `null` for no match.
 */
export function snippetFor(body: string, needle: string, title: string): string | null {
  for (const raw of body.split("\n")) {
    const line = plainLine(raw);
    // The heading that is the title: the row already says it, in bold.
    if (HEADING.test(raw.trim()) && line === title) continue;
    const at = line.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    const start = Math.max(0, at - SNIPPET_REACH);
    const end = Math.min(line.length, at + needle.length + SNIPPET_REACH);
    return `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`;
  }
  return null;
}

export function searchLocalNotes(
  notes: Readonly<Record<string, string>>,
  query: string,
  limit = 20,
): SearchAnswer {
  const needle = query.trim().toLowerCase();
  const byTitle: SearchAnswer["hits"] = [];
  const byBody: SearchAnswer["hits"] = [];
  if (needle !== "") {
    for (const [path, text] of Object.entries(notes)) {
      // A drawing's body is the canvas's data, not words anybody wrote.
      if (isDrawingPath(path)) continue;
      const title = noteHeading(text, path);
      const snippet = snippetFor(splitNote(text).body, needle, title);
      if (title.toLowerCase().includes(needle)) {
        byTitle.push({ path, title, snippets: snippet === null ? [] : [snippet] });
      } else if (snippet !== null) {
        byBody.push({ path, title, snippets: [snippet] });
      }
    }
  }
  return {
    hits: [...byTitle, ...byBody].slice(0, limit),
    indexMissing: false,
    indexIncomplete: false,
    reducedRecall: false,
    reducedRecallNotes: [],
  };
}
