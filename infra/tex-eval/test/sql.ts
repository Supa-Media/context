import { DatabaseSync } from "node:sqlite";

/** Durable Object SQL storage over Node's SQLite, as `TestSet` uses it: exec -> { toArray, one, rowsWritten }. */
export function sqlStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const st = db.prepare(query);
      if (/^\s*(SELECT|WITH)/i.test(query)) {
        const rows = st.all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, one: () => rows[0], rowsWritten: 0 };
      }
      const r = st.run(...(bindings as never[]));
      return { toArray: () => [], one: () => undefined, rowsWritten: Number(r.changes) };
    },
  };
}
