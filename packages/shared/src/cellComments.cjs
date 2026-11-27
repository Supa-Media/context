/**
 * Comments on one cell of a sheet, kept in the sheet's own file.
 *
 * A sheet is a `.csv` (`apps/mcp/src/sheets/csv.js`), and a CSV cell cannot
 * hold the HTML markers a note's comments use. So a sheet keeps its threads in
 * one column of its own, typed `comments` in the header (`comments:comments`),
 * which the grid never draws. Each row's cell in that column holds the threads
 * on that row's cells, in exactly the log a note's ` ```comments ` block holds
 * (`comments.cjs`), with the column's name where a note keeps the quoted words:
 *
 *     k7f2 "In a group"
 *     - 2026-11-27T07:30:12Z @seyi: @Tex can Tex read files sent in an SMS group?
 *     - 2026-11-27T07:30:20Z Tex: No, so this cell now says so.
 *
 * Decided by the owner, 2026-11-27: a column rather than the header or a file
 * beside the sheet, because rows have no stable id and a row's threads must
 * move with it when rows are sorted, inserted or deleted, and because the file
 * is the whole truth (docs/decisions/sheets.md).
 *
 * Every function here works on one cell's text and returns the cell's new
 * text, by wrapping it in a comments block and handing it to `comments.cjs`,
 * so the two formats can never drift apart.
 */

"use strict";

const comments = require("./comments.cjs");

/** The column type a sheet's comments column carries. */
const COMMENTS_TYPE = "comments";
/** The header a sheet gets for its first comment: a column called comments, typed comments. */
const COMMENTS_COLUMN = "comments";

function clean(cell) {
  return String(cell ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\n+$/g, "");
}

/** The cell's text as a note's comments block, or "" for an empty cell. */
function wrap(cell) {
  const body = clean(cell);
  return body === "" ? "" : `\`\`\`comments\n${body}\n\`\`\`\n`;
}

/** The block's body again, as the cell keeps it. */
function unwrap(text) {
  const block = comments.findBlock(text);
  if (block === null) return "";
  return clean(text.slice(block.bodyStart, block.bodyEnd));
}

/** The threads in one comments cell, oldest first. Each thread's `quote` is the column it is on. */
function cellThreads(cell) {
  const text = wrap(cell);
  return text === "" ? [] : comments.parseComments(text).threads;
}

/** A thread id not used anywhere in `cells` (every comments cell of the sheet). */
function newCellThreadId(cells, random) {
  const all = (Array.isArray(cells) ? cells : []).map(clean).filter((cell) => cell !== "");
  return comments.newThreadId(wrap(all.join("\n\n")), random);
}

/**
 * Start a thread on `column` with its first comment. Returns `{ cell }`, the
 * comments cell's new text, or `{ error }`.
 */
function addCellThread(cell, { id, column, author, body, at } = {}) {
  if (typeof id !== "string" || !/^[a-z][a-z0-9]{3,11}$/.test(id)) return { error: "a thread needs an id" };
  if (typeof column !== "string" || column.trim() === "") return { error: "a cell comment needs its column" };
  if (!String(body ?? "").trim()) return { error: "a comment needs some text" };
  const before = clean(cell);
  if (cellThreads(before).some((thread) => thread.id === id)) return { error: `there is already a thread "${id}"` };
  const header = `${id} ${JSON.stringify(column)}`;
  const text = wrap(before === "" ? header : `${before}\n\n${header}`);
  const added = comments.appendEvent(text, { thread: id, kind: "comment", author, body, at });
  if (added.error !== undefined) return { error: added.error };
  return { cell: unwrap(comments.applyChanges(text, added.changes)) };
}

/** A reply, a resolve or a reopen on a thread in this cell: `{ cell }` or `{ error }`, as `appendEvent` refuses. */
function appendCellEvent(cell, options = {}) {
  const text = wrap(cell);
  if (text === "") return { error: `there is no comment thread "${options.thread}" on this row` };
  const added = comments.appendEvent(text, options);
  if (added.error !== undefined) return { error: added.error };
  return { cell: unwrap(comments.applyChanges(text, added.changes)) };
}

/** Delete one comment, or a whole thread with its first: `{ cell }` or `{ error }`, as `deleteComment` does. */
function deleteCellComment(cell, options = {}) {
  const text = wrap(cell);
  if (text === "") return { error: `there is no comment thread "${options.thread}" on this row` };
  const removed = comments.deleteComment(text, options);
  if (removed.error !== undefined) return { error: removed.error };
  return { cell: unwrap(comments.applyChanges(text, removed.changes)) };
}

/** The same column renamed in every thread header of one cell, so a rename keeps its threads on their cells. */
function renameCellColumn(cell, from, to) {
  const text = wrap(cell);
  if (text === "") return clean(cell);
  const threads = comments.parseComments(text).threads.filter((thread) => thread.quote === from);
  if (threads.length === 0) return clean(cell);
  const changes = threads.map((thread) => {
    const line = text.slice(thread.headerStart, text.indexOf("\n", thread.headerStart));
    return { from: thread.headerStart, to: thread.headerStart + line.length, insert: `${thread.id} ${JSON.stringify(to)}` };
  });
  return unwrap(comments.applyChanges(text, changes));
}

module.exports = {
  COMMENTS_TYPE,
  COMMENTS_COLUMN,
  cellThreads,
  newCellThreadId,
  addCellThread,
  appendCellEvent,
  deleteCellComment,
  renameCellColumn,
};
