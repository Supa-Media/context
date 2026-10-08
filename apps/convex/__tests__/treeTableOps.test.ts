/**
 * The console's three uses of the tree table (`treeTableOps.ts`): which store a
 * sidebar walk reads, when a sweep is started, and the order a re-check and its
 * tree hint happen in.
 *
 * The order is the property worth a test of its own. A tab told "the tree
 * changed" walks again at once; if the hint went out before the table was
 * re-checked, that walk would read the row from before the change and the tab
 * would hold the old tree until the next hint.
 */

import { createRequire } from "node:module";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { FileStore } from "../functions/lib/fileOps";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { sweepTreePass } from "../../mcp/src/tree/sweep.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function sqliteClient() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    async query(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    },
    async runAll(statements: readonly { sql: string; params?: unknown[] }[]) {
      db.exec("BEGIN");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...(params as never[]));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { applied: statements.length, skipped: false };
    },
  };
}

let database = sqliteClient();
vi.mock("../../mcp/src/search/d1/client.js", async (original) => ({
  ...(await original<object>()),
  createD1Client: () => database,
}));

const ops = await import("../functions/lib/filesFns/treeTableOps");

const WS = "w1" as Id<"workspaces">;

function fakeCtx(options: { target: boolean }) {
  const scheduled: { operation: { kind: string } }[] = [];
  const marked: { audiences: string[]; rows: string[] }[] = [];
  const ctx = {
    runQuery: vi.fn(async () => (options.target ? { databaseId: "db-1", state: "ready" } : null)),
    runAction: vi.fn(async () => "configured"),
    runMutation: vi.fn(async (_ref: unknown, args: { audiences: string[] }) => {
      const rows = (await database.query("SELECT path FROM tree ORDER BY path").catch(() => [])).map(
        (row) => String(row.path),
      );
      marked.push({ audiences: args.audiences, rows });
      return null;
    }),
    scheduler: {
      runAfter: vi.fn(async (_delay: number, _ref: unknown, args: { operation: { kind: string } }) => {
        scheduled.push(args);
        return "job";
      }),
    },
  };
  return { ctx: ctx as never, scheduled, marked };
}

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed("1-projects/a.md", "# A\n");
  store.seed("2-areas/b.md", "# B\n");
  return store;
}

const ARGS = { workspaceId: WS, scope: "private" as const };

beforeEach(() => {
  database = sqliteClient();
});

describe("which store a sidebar walk reads", () => {
  test("only a manifest that asks for the table is ever given it", async () => {
    const { ctx, scheduled } = fakeCtx({ target: true });
    const store = bucket();
    const answer = await ops.manifestSource(ctx, { ...ARGS, operation: { kind: "manifest" } }, store);
    expect(answer).toEqual({ store, source: "bucket" });
    expect(scheduled).toEqual([]);
  });

  test("a context with no database walks the bucket and starts nothing", async () => {
    const { ctx, scheduled } = fakeCtx({ target: false });
    const store = bucket();
    const answer = await ops.manifestSource(ctx, { ...ARGS, operation: { kind: "manifest", source: "tree" } }, store);
    expect(answer.source).toBe("bucket");
    expect(scheduled).toEqual([]);
  });

  test("a table never swept walks the bucket this time and starts a sweep", async () => {
    const { ctx, scheduled } = fakeCtx({ target: true });
    const answer = await ops.manifestSource(ctx, { ...ARGS, operation: { kind: "manifest", source: "tree" } }, bucket());
    expect(answer.source).toBe("bucket");
    expect(scheduled.map((args) => args.operation)).toEqual([{ kind: "sweepTree", passes: 0 }]);
  });

  test("a swept table is read, and a fresh one starts nothing", async () => {
    const store = bucket();
    await sweepTreePass(store, database);
    const { ctx, scheduled } = fakeCtx({ target: true });
    const answer = await ops.manifestSource(ctx, { ...ARGS, operation: { kind: "manifest", source: "tree" } }, store);
    expect(answer.source).toBe("tree");
    expect(scheduled).toEqual([]);
    const listed = await answer.store.list({ prefix: "" });
    expect(listed.objects.map((object) => object.key)).toEqual(["1-projects/a.md", "2-areas/b.md"]);
  });
});

describe("a console change", () => {
  test("is re-checked in the table before its audiences are told", async () => {
    const store = bucket();
    await sweepTreePass(store, database);
    store.seed("1-projects/new.md", "# New\n");
    const { ctx, marked } = fakeCtx({ target: true });
    await ops.runTreeOperation(
      ctx,
      { ...ARGS, operation: { kind: "touchTree", paths: ["1-projects/new.md"], files: [], audiences: ["private"] } },
      store,
      database,
    );
    expect(marked).toHaveLength(1);
    expect(marked[0]!.rows).toContain("1-projects/new.md");
  });

  test("is handed to a re-check where there is a table, and told at once where there is none", async () => {
    const withTable = fakeCtx({ target: true });
    await ops.keepTreeAndAnnounce(withTable.ctx, ARGS, { paths: ["a.md"], files: [], audiences: ["private"] });
    expect(withTable.marked).toEqual([]);
    expect(withTable.scheduled.map((args) => args.operation.kind)).toEqual(["touchTree"]);

    const without = fakeCtx({ target: false });
    await ops.keepTreeAndAnnounce(without.ctx, ARGS, { paths: ["a.md"], files: [], audiences: ["private"] });
    expect(without.scheduled).toEqual([]);
    expect(without.marked.map((mark) => mark.audiences)).toEqual([["private"]]);
  });

  test("a re-check whose context lost its database still delivers the hint", async () => {
    const { ctx, marked } = fakeCtx({ target: false });
    const answer = await ops.treeOperationClient(ctx, {
      workspaceId: WS,
      operation: { kind: "touchTree", paths: ["a.md"], files: [], audiences: ["team"] },
    } as never);
    expect(answer).toEqual({ client: null });
    expect(marked.map((mark) => mark.audiences)).toEqual([["team"]]);
  });

  test("a sweep that finished schedules no further pass", async () => {
    const { ctx, scheduled } = fakeCtx({ target: true });
    const answer = await ops.runTreeOperation(ctx, { ...ARGS, operation: { kind: "sweepTree" } }, bucket(), database);
    expect(answer).toEqual({ kind: "treeKept", complete: true });
    expect(scheduled).toEqual([]);
  });
});
