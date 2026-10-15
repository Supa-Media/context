/**
 * A fast search database over real SQLite (`node:sqlite`, the FTS5 D1 runs),
 * seeded as a converged database would be, behind the two methods the control
 * plane's `ProjectionClient` has.
 */

import { createRequire } from "node:module";
import { SCHEMA_STATEMENTS } from "../functions/lib/d1";
import { projectNote, upsertStatements } from "../../mcp/src/search/d1/project.js";

// Through `createRequire`: Vite does not resolve `node:sqlite` as an import.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export function sqliteProjection() {
  const db = new DatabaseSync(":memory:");
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
  const run = (sql: string, params: unknown[] = []) =>
    db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  return {
    paths: () => (run("SELECT path FROM notes ORDER BY path") as { path: string }[]).map((row) => row.path),
    /** Each note's tier, `path` to `visibility`. */
    tiers: () =>
      Object.fromEntries((run("SELECT path, visibility FROM notes") as { path: string; visibility: string }[]).map((row) => [row.path, row.visibility])),
    seed(path: string, content: string, visibility: "private" | "team" = "private") {
      for (const { sql, params } of upsertStatements(path, projectNote(path, { version: "v0", uploaded: null, visibility, content }))) {
        run(sql, params);
      }
    },
    client: {
      async query(sql: string, params: unknown[] = []) {
        return run(sql, params);
      },
      async runAll(statements: readonly { sql: string; params?: unknown[] }[]) {
        for (const { sql, params } of statements) run(sql, params ?? []);
        return { applied: statements.length, skipped: false };
      },
    },
  };
}
