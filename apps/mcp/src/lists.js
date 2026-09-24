/**
 * Folder lists: a ```list fence that shows the notes in a folder.
 *
 * ## What this file is for
 *
 * Any note may carry a block like
 *
 *     ```list
 *     from: 1-projects
 *     where: status is active
 *     sort: updated, newest first
 *     show: owner, updated
 *     ```
 *
 * and every surface that draws it — the editor, a shared page, a website —
 * shows the same rows: the notes in that folder whose properties match, as
 * links, kept current as notes change. Nothing about it is website-specific; a
 * blog index is one use of it and a projects page is another.
 *
 * ## Two rules hold the design up
 *
 * 1. **A block that does not parse draws its error, never a guess.** Same
 *    discipline as forms and the privacy manifest: `parseListBlocks` returns
 *    the first reason a block is wrong, with its line, and nothing half-read.
 *
 * 2. **Selection only ever narrows.** `selectListRows` filters, sorts and
 *    trims the notes its caller passes in. It never fetches, so it can never
 *    show a note the caller could not already see: privacy, drafts and share
 *    scope are decided before it runs. It additionally refuses plumbing under
 *    `.context/` and the note holding the block, even for a config that never
 *    went through the parser.
 *
 * Zero dependencies, Workers runtime, and imported by the mobile app, so both
 * halves read one grammar. Split into `lists/`: `grammar.js` (the constants),
 * `parseBlock.js` (the fence and its body), `renderBlock.js` (config back to
 * text, for an editor that changes a filter) and `select.js` (the rows).
 */

export { LIST_FENCE_LANG } from "./lists/grammar.js";
export { parseListBlocks, parseListBody } from "./lists/parseBlock.js";
export { renderListBlock } from "./lists/renderBlock.js";
export { selectListRows } from "./lists/select.js";
