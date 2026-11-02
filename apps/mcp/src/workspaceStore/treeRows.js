/**
 * The rows one folder listing reads from a workspace object's SQLite
 * (`workspaceStore/rows.js` owns the table): the folder's live children, its
 * own row, and the rows `folderJobs` needs (top-level folders and every row
 * with a job). Read-only, and only ever handed to `listing.js`, which decides
 * what a reader sees.
 *
 * `role`, `ord`, `archive_of` and `uploaded` are the row's own folder job,
 * place among its siblings, archive twin and last write.
 */

import { LISTING_ROWS } from "./listing.js";

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
const num = (value) => (value === null || value === undefined ? null : Number(value));

function treeRow(row) {
  return {
    path: row.path,
    kind: row.kind,
    size: num(row.size),
    uploaded: num(row.uploaded),
    role: typeof row.role === "string" ? row.role : null,
    order: num(row.ord),
    archiveOf: typeof row.archive_of === "string" ? row.archive_of : null,
  };
}

/** The highest code point, so `prefix .. prefix + END` is every path under `prefix`. */
const END = "\u{10FFFF}";

export function treeRows(sql) {
  return {
    /** Live children of `folder` (`""` is the root), at most `LISTING_ROWS`, and whether there were more. */
    children(folder) {
      const found =
        folder === ""
          ? all(sql.exec("SELECT * FROM ws_rows WHERE gone = 0 AND path <> '' AND instr(path, '/') = 0 ORDER BY path LIMIT ?", LISTING_ROWS + 1))
          : all(
              sql.exec(
                "SELECT * FROM ws_rows WHERE gone = 0 AND path > ? AND path < ? AND instr(substr(path, ?), '/') = 0 ORDER BY path LIMIT ?",
                `${folder}/`,
                `${folder}/${END}`,
                folder.length + 2,
                LISTING_ROWS + 1,
              ),
            );
      const more = found.length > LISTING_ROWS;
      return { rows: (more ? found.slice(0, LISTING_ROWS) : found).map(treeRow), more };
    },
    /** The folder's own live row, or null. */
    own(folder) {
      if (folder === "") return null;
      const row = all(sql.exec("SELECT * FROM ws_rows WHERE gone = 0 AND path = ? ORDER BY at DESC LIMIT 1", folder))[0];
      return row ? treeRow(row) : null;
    },
    /** Top-level folders, and every row with a job: what `folderJobs` reads. */
    jobRows() {
      return all(
        sql.exec("SELECT * FROM ws_rows WHERE gone = 0 AND ((kind = 'folder' AND instr(path, '/') = 0) OR role IS NOT NULL)"),
      ).map(treeRow);
    },
    /** What the newest row at `path` is or was (a removed row keeps its path), or null. */
    kindAt(path) {
      const row = all(sql.exec("SELECT kind FROM ws_rows WHERE path = ? ORDER BY at DESC LIMIT 1", path))[0];
      return row ? row.kind : null;
    },
  };
}
