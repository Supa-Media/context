/**
 * A database that runs real SQL (`node:sqlite`, the engine D1 runs), for the
 * tests of what the search database keeps. It once served the tree table's
 * tests too; those tables were retired in phase 7 (`src/tree/retired.js`).
 */

import { DatabaseSync } from "node:sqlite";

export function sqliteClient() {
  const db = new DatabaseSync(":memory:");
  const client = {
    db,
    async query(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async runAll(statements) {
      db.exec("BEGIN");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { applied: statements.length, skipped: false };
    },
  };
  return client;
}
