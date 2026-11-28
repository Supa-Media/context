/**
 * A file's words in parts, and which files are tables (`apps/mcp/src/tools/fileParts.js`): the part a reader hands back,
 * where the next part starts, and the table rule. Pure: no I/O. The original module keeps the table facts.
 *
 * Plain CommonJS with no imports.
 */

/** Most characters handed back in one part. */
const PART_CHARS = 100_000;

const TABLE_TYPES = new Set(["text/csv", "text/tab-separated-values"]);
const TABLE_NAME = /\.(?:csv|tsv)$/i;

/** Whether a file is a table whose facts are worked out here. */
function isTable(name, type) {
  return TABLE_TYPES.has(String(type ?? "").split(";")[0].trim().toLowerCase()) || TABLE_NAME.test(String(name ?? ""));
}

/**
 * One part of `text` from `from`: at most `PART_CHARS`, ending at a line break
 * when there is one, so no row is cut in two. `{ part, from, to, total }`, or
 * null when `from` is past the end.
 */
function partOf(text, from = 0) {
  const total = text.length;
  const start = Number.isInteger(from) && from > 0 ? from : 0;
  if (start > 0 && start >= total) return null;
  let to = Math.min(total, start + PART_CHARS);
  if (to < total) {
    const lineEnd = text.lastIndexOf("\n", to);
    if (lineEnd > start) to = lineEnd + 1;
  }
  return { part: text.slice(start, to), from: start, to, total };
}

/** The lines that say which part this is and how to read the next one. */
function partLines(part, next) {
  const lines = [`characters: ${part.from} to ${part.to} of ${part.total}`];
  if (part.to < part.total) lines.push(`more: ${next(part.to)} reads the next part; read every part before you total anything`);
  return lines;
}

module.exports = { PART_CHARS, isTable, partLines, partOf };
