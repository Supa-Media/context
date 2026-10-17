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
  for (const { path, content, visibility, version = `v-${path}` } of notes) {
    const projected = projectNote(path, { version, visibility, content });
    for (const { sql, params } of upsertStatements(path, projected)) db.prepare(sql).run(...params);
    written += 1;
  }
  return written;
}
