// A Durable Object's `sql` over node:sqlite for the workspace object's tests: `exec(query, ...binds)` returns a cursor
// with `toArray()`, and `transact` is `transactionSync`'s shape (commits on return, rolls back on a throw).
import { DatabaseSync } from "node:sqlite";

export function durableSqlite() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
  const transact = (work) => {
    db.exec("BEGIN");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return { sql, transact };
}
