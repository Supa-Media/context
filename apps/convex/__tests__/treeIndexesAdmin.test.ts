/**
 * The admin tree index panel (`lib/adminFns/treeIndexes.ts`): each
 * workspace's table read from its own database, the ones needing attention
 * first, and Fill starting a sweep for every workspace asked about.
 */

import { createRequire } from "node:module";
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { memoryStore } from "./storeStub.helpers";
import { sweepTreePass } from "../../mcp/src/tree/sweep.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function sqliteClient() {
  const db = new DatabaseSync(":memory:");
  return {
    async query(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    },
    async runAll(statements: readonly { sql: string; params?: unknown[] }[]) {
      for (const { sql, params = [] } of statements) db.prepare(sql).run(...(params as never[]));
      return { applied: statements.length, skipped: false };
    },
  };
}

const databases = new Map<string, ReturnType<typeof sqliteClient>>();
vi.mock("../../mcp/src/search/d1/client.js", async (original) => ({
  ...(await original<object>()),
  createD1Client: ({ databaseId }: { databaseId: string }) => {
    if (databaseId === "gone") throw new Error("no such database");
    return databases.get(databaseId);
  },
}));

const { treeIndexReport, fillTreeIndexes } = await import("../functions/lib/adminFns/treeIndexes");
const { treeStateOf } = await import("../functions/lib/filesFns/treeTableOps");

function target(id: string) {
  return { workspaceId: id as Id<"workspaces">, slug: id, databaseId: id, state: "ready" as const };
}

// The barrier's `treeState`, as `runFileOperation` answers it.
const ctx = {
  runAction: vi.fn(async (_ref: unknown, args: { workspaceId: string }) => {
    const client = databases.get(args.workspaceId);
    if (client === undefined) throw new Error("no database");
    return await treeStateOf(client as never);
  }),
  scheduler: { runAfter: vi.fn(async () => "job") },
};

describe("the tree index panel", () => {
  test("says which tables are filled, empty or out of reach, the empty ones first", async () => {
    const filled = sqliteClient();
    const store = memoryStore();
    store.seed("1-projects/a.md", "# A\n");
    store.seed("2-areas/b.md", "# B\n");
    await sweepTreePass(store, filled);
    databases.set("filled", filled);
    databases.set("empty", sqliteClient());

    const report = await treeIndexReport(ctx as never, {
      targets: [target("filled"), target("empty"), target("gone")],
      truncated: false,
    });
    expect(report.rows.map((row) => [row.slug, row.status, row.rows])).toEqual([
      ["gone", "unreachable", null],
      ["empty", "empty", 0],
      ["filled", "ready", 2],
    ]);
    expect(JSON.stringify(report)).not.toContain("1-projects");
  });

  test("a sweep that keeps failing reads as stuck, with why, and never with the key", async () => {
    const stuck = sqliteClient();
    const store = memoryStore();
    store.seed("2-areas/codes/secret plan.md", "# S\n");
    const failing = {
      ...store,
      list: async () => {
        throw new Error('S3 LIST failed for "2-areas/codes/secret plan draft.md" at 2-areas/codes/secret plan draft.md: 403 AccessDenied');
      },
    };
    await expect(sweepTreePass(failing, stuck)).rejects.toThrow(/AccessDenied/);
    databases.set("stuck", stuck);
    const report = await treeIndexReport(ctx as never, { targets: [target("stuck")], truncated: false });
    expect(report.rows[0]?.error).toBe("Tree fill failed; inspect service logs");
    expect(JSON.stringify(report)).not.toMatch(/2-areas|codes|secret|plan|draft|AccessDenied/);
  });

  test("Fill starts a sweep for every workspace asked about", async () => {
    ctx.scheduler.runAfter.mockClear();
    expect(await fillTreeIndexes(ctx as never, [target("a"), target("b")])).toBe(2);
    expect(ctx.scheduler.runAfter.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
      { workspaceId: "a", scope: "private", operation: { kind: "sweepTree", passes: 0 } },
      { workspaceId: "b", scope: "private", operation: { kind: "sweepTree", passes: 0 } },
    ]);
  });
});
