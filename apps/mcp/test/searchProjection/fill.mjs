import { projectNote, upsertStatements } from "../../src/search/d1/project.js";

/**
 * A context's search database filled the way the control plane fills it.
 *
 * A search no longer copies anything into the database behind its answer
 * (decided by the owner, 2026-10-17): writes keep it current and Convex's
 * scheduled passes fill and repair it (`apps/convex/functions/lib/fileOps/
 * projection.ts`, covered by `searchBackfill.test.ts`). A gateway test that
 * needs a filled database writes the rows the same projection would, through
 * the same `projectNote` and `upsertStatements`, so what a search reads back
 * is exactly what production holds.
 *
 * @param {import("node:sqlite").DatabaseSync} db one context's database,
 *   `createD1Backend().dbFor(databaseId)`.
 * @param {Iterable<{path: string, content: string, visibility: string, version?: string}>} notes
 * @returns {number} the notes written
 */
export function fillSearchDatabase(db, notes) {
  let written = 0;
  // One transaction, each statement prepared once: written one autocommit at a time, a 10,000-note benchmark
  // corpus took three minutes to fill (2026-11-22); the rows are the same either way.
  const prepared = new Map();
  const statementOf = (sql) => {
    if (!prepared.has(sql)) prepared.set(sql, db.prepare(sql));
    return prepared.get(sql);
  };
  db.exec("BEGIN");
  try {
    for (const { path, content, visibility, version = `v-${path}` } of notes) {
      const projected = projectNote(path, { version, visibility, content });
      // A note the database has never held has no rows to delete, and a DELETE by path scans a whole full-text
      // table (its path is not an index there): skipped, a fill of n new notes is linear rather than n².
      const known = statementOf("SELECT 1 FROM notes WHERE path = ?").get(path) !== undefined;
      for (const { sql, params } of upsertStatements(path, projected)) {
        if (!known && /^\s*DELETE\b/i.test(sql)) continue;
        statementOf(sql).run(...params);
      }
      written += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return written;
}
