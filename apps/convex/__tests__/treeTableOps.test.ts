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
  test("only a manifest that asks for the table is ever given it, but any walk starts it filling", async () => {
    const { ctx, scheduled } = fakeCtx({ target: true });
    const store = bucket();
    const answer = await ops.manifestSource(ctx, { ...ARGS, operation: { kind: "manifest" } }, store);
    expect(answer).toEqual({ store, source: "bucket" });
    expect(scheduled.map((args) => args.operation)).toEqual([{ kind: "sweepTree", passes: 0 }]);
    // Once per walk, not once per page.
    await ops.manifestSource(ctx, { ...ARGS, operation: { kind: "manifest", cursor: "a" } }, store);
    expect(scheduled).toHaveLength(1);
  });

  test("a walk of a filled table starts nothing", async () => {
    const store = bucket();
    await sweepTreePass(store, database);
    const { ctx, scheduled } = fakeCtx({ target: true });
    await ops.manifestSource(ctx, { ...ARGS, operation: { kind: "manifest" } }, store);
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

  test("a table walk's first page says where a catch-up after it starts", async () => {
    const store = bucket();
    store.seed("privacy.md", "# Privacy\n");
    await sweepTreePass(store, database);
    const { ctx } = fakeCtx({ target: true });
    const first = await ops.manifestSource(ctx, { ...ARGS, operation: { kind: "manifest", source: "tree" } }, store);
    expect(first.privacy).toBe((await store.get("privacy.md"))!.etag);
    expect(first.since).toBeLessThan(Date.now());
    const later = await ops.manifestSource(ctx, { ...ARGS, operation: { kind: "manifest", source: "tree", cursor: "a" } }, store);
    expect(later.since).toBeUndefined();
  });

  test("a catch-up for a context with no table walks instead", () => {
    expect(ops.noTreeTable({ kind: "treeChanges", since: 5 })).toMatchObject({ kind: "treeChanges", full: true, since: 5 });
    expect(ops.noTreeTable({ kind: "sweepTree" })).toEqual({ kind: "treeKept", complete: false });
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

  test("a change to a context whose table was never filled starts the filling", async () => {
    const store = bucket();
    const { ctx, scheduled } = fakeCtx({ target: true });
    await ops.runTreeOperation(
      ctx,
      { ...ARGS, operation: { kind: "touchTree", paths: ["1-projects/a.md"], files: [], audiences: ["private"] } },
      store,
      database,
    );
    expect(scheduled.map((args) => args.operation)).toEqual([{ kind: "sweepTree", passes: 0 }]);

    await sweepTreePass(store, database);
    // A whole table: a change to its shape has the links it touched read now,
    // and a save of text alone waits for the next reader rather than a pass per save.
    const after = fakeCtx({ target: true });
    await ops.runTreeOperation(
      after.ctx,
      { ...ARGS, operation: { kind: "touchTree", paths: ["1-projects/a.md"], files: [], audiences: ["private"] } },
      store,
      database,
    );
    expect(after.scheduled.map((args) => args.operation)).toEqual([{ kind: "sweepTree", passes: 0 }]);
    const saved = fakeCtx({ target: true });
    await ops.runTreeOperation(
      saved.ctx,
      { ...ARGS, operation: { kind: "touchTree", paths: [], files: ["1-projects/a.md"], audiences: [] } },
      store,
      database,
    );
    expect(saved.scheduled).toEqual([]);
  });

  test("a deleted note carries who could see it before, not who could after", async () => {
    const { ctx, scheduled } = fakeCtx({ target: true });
    const store = bucket();
    const before = {
      rules: [{ prefix: "1-projects/", vis: "team" as const }],
      overrides: new Map([["1-projects/a.md", "private" as const]]),
      text: "",
      etag: "p",
      invalid: false,
    };
    await ops.announceTreeChange(
      ctx,
      store,
      ARGS,
      { paths: ["1-projects/a.md"], narrows: true, gone: ["1-projects/a.md"] },
      { kind: "deleted", paths: ["1-projects/a.md"] } as never,
      before as never,
    );
    const touch = scheduled.map((args) => args.operation).find((operation) => operation.kind === "touchTree") as
      | { left?: { path: string; audiences: string[] }[] }
      | undefined;
    expect(touch?.left).toEqual([{ path: "1-projects/a.md", audiences: ["private"] }]);
  });

  test("a sweep that finished goes on to read the links, and stops once they are read", async () => {
    const store = bucket();
    const { ctx, scheduled } = fakeCtx({ target: true });
    const answer = await ops.runTreeOperation(ctx, { ...ARGS, operation: { kind: "sweepTree" } }, store, database);
    expect(answer).toEqual({ kind: "treeKept", complete: true });
    expect(scheduled.map((args) => args.operation)).toEqual([{ kind: "sweepTree", passes: 1 }]);

    // The next pass finds the tree whole and no sweep due: it reads the links.
    const links = fakeCtx({ target: true });
    const read = await ops.runTreeOperation(links.ctx, { ...ARGS, operation: { kind: "sweepTree", passes: 1 } }, store, database);
    expect(read).toEqual({ kind: "treeKept", complete: true });
    expect(links.scheduled).toEqual([]);
    const [sources] = await database.query("SELECT count(*) AS n FROM tree_link_sources");
    expect(Number(sources!.n)).toBeGreaterThan(0);
    const [ready] = await database.query("SELECT value FROM index_state WHERE key = 'tree_links_ready'");
    expect(ready?.value).toBe("1");
  });
});
