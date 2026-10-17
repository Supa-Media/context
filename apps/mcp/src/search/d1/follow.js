/**
 * Fast search following a change it was told about, instead of waiting for a
 * sweep to rediscover it.
 *
 * ## The bug this closes
 *
 * A ready projection answers every search, and its miss is the answer (Dev2,
 * 2026-10-08; `serve.js`). Only three writers projected what they wrote:
 * `write_note`, form answers and the live editor. Everything else reached the
 * projection when the backfill's sweep window came round to it — and nothing
 * ever took a path OUT, because the sweep walks the paths the R2 index holds
 * and a moved note's old path is exactly the one it no longer holds. Measured
 * on production, 2026-10-13: a note moved with `move_note` was found at its
 * old name, which no longer opens, and not at its new one, minutes later. The
 * same held for every rename and move made in the app, email arriving in the
 * inbox, `save_context`, meeting notes and links rewritten after a move.
 *
 * ## What it does
 *
 * - A path that is gone loses its rows; a folder that is gone loses every row
 *   under it.
 * - A written note is read once and projected, as the backfill would.
 * - A note moved to another folder under the same name is renamed in place,
 *   with no read: such a move changes no text (plan section 3.6 of notes by
 *   id: a move never re-indexes). A note given a new name is read and
 *   projected again, since its title follows its name: from the file name
 *   when it has no heading, and from the heading the rename rewrites when it
 *   has one (`followHeading.ts`, "a note's heading is its name"). So is a note
 *   the projection does not hold yet, and a drawing.
 * - A moved FOLDER is renamed in place, with no reads, the same way. The rows
 *   keep the version they had, so the sweep still sees them as stale and
 *   re-projects them in its own time.
 * - Every renamed note whose tier the new place changes has its rows moved to
 *   the other tier's table there and then, with no read (`tierMoveStatements`),
 *   so a note moved somewhere narrower never keeps its wider tier's rows,
 *   which `upsertStatements` explains the cost of.
 *
 * Bounded by `FOLLOW_NOTE_CAP` reads. Past it the sweep finishes the job, as
 * it did before; this only makes the common case immediate. The renames cost
 * one `SELECT` of the moved rows and no reads at all.
 *
 * Takes the client and a `visibilityOf` and knows nothing about who calls it,
 * so the gateway (`writeProjection.js`) and the control plane's console
 * operations (`indexNotes`) follow a change the same way.
 */

import { indexableText } from "../../encryption/format.js";
import { isDrawingPath } from "../../../../../packages/drawings/src/excalidraw.js";
import { deleteStatements, FTS_TABLE, ftsTableFor, projectNote, upsertStatements } from "./project.js";

/** Notes one change may read to project. The rest wait for the sweep. */
export const FOLLOW_NOTE_CAP = 20;

/** Moved notes looked up in the projection per `SELECT`, under D1's bound-parameter limit. */
const NOTE_LOOKUP_BATCH = 50;

const TABLES = ["notes", FTS_TABLE.private, FTS_TABLE.team];

/** A note path this projection holds: Markdown, and no dot-segment anywhere. */
export function followsNote(path) {
  return (
    typeof path === "string" &&
    path.endsWith(".md") &&
    !path.startsWith("/") &&
    !path.split("/").some((segment) => segment === "" || segment.startsWith("."))
  );
}

/** A folder path this projection can rename or clear: no `.md`, no dot-segment. */
function followsFolder(path) {
  return (
    typeof path === "string" &&
    path !== "" &&
    !path.endsWith(".md") &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    !path.split("/").some((segment) => segment === "" || segment.startsWith("."))
  );
}

/** `LIKE` pattern for everything under `folder/`, with `%`, `_` and `\` taken literally. */
export function underPattern(folder) {
  return `${folder.replace(/[\\%_]/g, (character) => `\\${character}`)}/%`;
}

/** Remove every row under a folder. */
export function folderDeleteStatements(folder) {
  const pattern = underPattern(folder);
  return TABLES.map((table) => ({
    sql: `DELETE FROM ${table} WHERE path LIKE ? ESCAPE '\\'`,
    params: [pattern],
  }));
}

/**
 * Rename every row under `from/` to sit under `to/`.
 *
 * Rows already at a destination path are removed first, so a stale row there
 * cannot collide with `notes`' primary key or leave an FTS table holding two
 * copies of one note. `substr(path, n)` is 1-based: with `n` the length of
 * `from` plus one it keeps the `/rest` after the folder.
 */
export function folderMoveStatements(from, to) {
  const pattern = underPattern(from);
  const keep = from.length + 1;
  const statements = [];
  for (const table of TABLES) {
    statements.push({
      sql: `DELETE FROM ${table} WHERE path IN (
              SELECT ? || substr(path, ?) FROM ${table} WHERE path LIKE ? ESCAPE '\\'
            )`,
      params: [to, keep, pattern],
    });
    statements.push({
      sql: `UPDATE ${table} SET path = ? || substr(path, ?) WHERE path LIKE ? ESCAPE '\\'`,
      params: [to, keep, pattern],
    });
  }
  return statements;
}

/** A path's last segment. */
function nameOf(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Rename one note's rows from `from` to `to`, removing any rows already at
 * `to` first, as `folderMoveStatements` does for a folder.
 */
export function noteMoveStatements(from, to) {
  return [
    ...deleteStatements(to),
    ...TABLES.map((table) => ({ sql: `UPDATE ${table} SET path = ? WHERE path = ?`, params: [to, from] })),
  ];
}

/**
 * Move a renamed note's rows into the tier its new place gives it, copying
 * the chunks across rather than reading the note: the text is the same, only
 * the table its corpus statistics count in is not. A tier this projection does
 * not know removes the rows, `upsertStatements`'s safe failure.
 */
export function tierMoveStatements(path, from, to) {
  const source = ftsTableFor(from);
  const target = ftsTableFor(to);
  if (target === undefined || source === undefined) return deleteStatements(path);
  const statements = [];
  if (source !== target) {
    statements.push(
      { sql: `DELETE FROM ${target} WHERE path = ?`, params: [path] },
      {
        sql: `INSERT INTO ${target} (path, ord, title, headings, tags, body)
              SELECT path, ord, title, headings, tags, body FROM ${source} WHERE path = ?`,
        params: [path],
      },
      { sql: `DELETE FROM ${source} WHERE path = ?`, params: [path] },
    );
  }
  statements.push({ sql: `UPDATE notes SET visibility = ? WHERE path = ?`, params: [to, path] });
  return statements;
}

/**
 * Follow one change. Throws what the client throws (a `D1Error`); the caller
 * decides that a derivative failing is never a failed write.
 *
 * @param {{ get: (path: string) => Promise<{ etag?: string, text: () => Promise<string> } | null> }} store
 * @param {{ query: Function, runAll: Function }} client
 * @param {object} change
 * @param {string[]} [change.written] notes that hold new text
 * @param {string[]} [change.gone] notes or folders that are no longer there
 * @param {[string, string][]} [change.moved] `[from, to]`, notes or folders
 * @param {(path: string) => string} change.visibilityOf the privacy engine, bound
 * @param {number} [change.noteCap]
 * @param {(path: string, content: string, visibility: string) => void} [change.onRead]
 *   told each note's text as it is projected, so a caller can embed it too
 *   without reading it twice
 * @returns {Promise<{ projected: number, deleted: number, renamed: number, deferred: number }>}
 */
export async function followChange(
  store,
  client,
  { written = [], gone = [], moved = [], visibilityOf, noteCap = FOLLOW_NOTE_CAP, onRead = null } = {},
) {
  const result = { projected: 0, deleted: 0, renamed: 0, deferred: 0 };
  const statements = [];
  const toProject = [];
  const removed = new Set();
  const renamedFolders = [];
  const noteMoves = [];

  const remove = (path) => {
    if (followsNote(path)) {
      if (removed.has(path)) return;
      removed.add(path);
      statements.push(...deleteStatements(path));
      result.deleted += 1;
    } else if (followsFolder(path)) {
      statements.push(...folderDeleteStatements(path));
      result.deleted += 1;
    }
  };
  const write = (path) => {
    if (followsNote(path) && !toProject.includes(path)) toProject.push(path);
  };

  for (const pair of Array.isArray(moved) ? moved : []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [from, to] = pair;
    // A destination this projection does not hold (the trash, plumbing) is
    // still a source that is gone.
    if (followsNote(from) && followsNote(to) && from !== to && nameOf(from) === nameOf(to) && !isDrawingPath(to)) {
      noteMoves.push([from, to]);
    } else if (followsNote(from)) {
      remove(from);
      write(to);
    } else if (followsFolder(from) && followsFolder(to) && from !== to) {
      statements.push(...folderMoveStatements(from, to));
      renamedFolders.push(to);
      result.renamed += 1;
    } else if (followsFolder(from)) {
      remove(from);
    } else {
      write(to);
    }
  }
  // The moved notes the projection holds are renamed in place, and the tier
  // each was projected at is what decides whether its rows change table.
  // One query for all of them.
  const renamedNotes = [];
  if (noteMoves.length > 0) {
    const held = new Map();
    for (let start = 0; start < noteMoves.length; start += NOTE_LOOKUP_BATCH) {
      const sources = noteMoves.slice(start, start + NOTE_LOOKUP_BATCH).map(([from]) => from);
      const rows = await client.query(
        `SELECT path, visibility FROM notes WHERE path IN (${sources.map(() => "?").join(", ")})`,
        sources,
      );
      for (const row of rows) if (typeof row?.path === "string") held.set(row.path, row);
    }
    for (const [from, to] of noteMoves) {
      const row = held.get(from);
      if (row === undefined) {
        remove(from);
        write(to);
        continue;
      }
      statements.push(...noteMoveStatements(from, to));
      renamedNotes.push({ path: to, visibility: row.visibility });
      result.renamed += 1;
    }
  }

  for (const path of Array.isArray(gone) ? gone : []) remove(path);
  for (const path of Array.isArray(written) ? written : []) write(path);

  // The removals and renames first, in one request: they read nothing.
  if (statements.length > 0) await client.runAll(statements);

  // A renamed note whose new place gives it another tier: its rows change
  // table, with no read. A note about to be projected anyway is left to that.
  const tierMoves = [];
  const retier = (path, held) => {
    if (toProject.includes(path)) return;
    const now = visibilityOf(path);
    if (now !== held) tierMoves.push(...tierMoveStatements(path, held, now));
  };
  for (const { path, visibility } of renamedNotes) retier(path, visibility);
  for (const folder of renamedFolders) {
    const rows = await client.query(
      `SELECT path, visibility FROM notes WHERE path LIKE ? ESCAPE '\\'`,
      [underPattern(folder)],
    );
    for (const row of rows) {
      if (typeof row?.path === "string") retier(row.path, row.visibility);
    }
  }
  if (tierMoves.length > 0) await client.runAll(tierMoves);

  const projections = [];
  for (const path of toProject) {
    if (result.projected >= noteCap) {
      // Too many to read now. A note whose rows could sit in a wider tier
      // than it now has loses them; the sweep projects it again, since a
      // missing row never matches the version it holds.
      projections.push(...deleteStatements(path));
      result.deferred += 1;
      continue;
    }
    let object;
    try {
      object = await store.get(path);
    } catch {
      projections.push(...deleteStatements(path));
      result.deferred += 1;
      continue;
    }
    if (!object) {
      projections.push(...deleteStatements(path));
      result.deleted += 1;
      continue;
    }
    const visibility = visibilityOf(path);
    const content = indexableText(await object.text());
    // `upsertStatements` indexes nothing for a visibility it does not know,
    // after deleting both tiers' rows — the safe failure, kept.
    projections.push(
      ...upsertStatements(
        path,
        projectNote(path, {
          version: typeof object.etag === "string" ? object.etag : "",
          uploaded: null,
          visibility,
          content,
        }),
      ),
    );
    result.projected += 1;
    if (typeof onRead === "function") onRead(path, content, visibility);
  }
  if (projections.length > 0) await client.runAll(projections);
  return result;
}
