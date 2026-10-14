/**
 * The console's file tree after phase 7 (`treeOps.ts`): which store a walk or
 * the map reads, what a List and the chaos score answer where the Convex
 * facts cannot, and the order a re-check and its tree hint happen in.
 *
 * The D1 copy of the tree is gone, so nothing here may ask for a search
 * database or schedule its sweep: every case records what was scheduled and
 * which functions were asked, and fails on a D1 operation or a database
 * lookup.
 *
 * The order is the property worth a test of its own. A tab told "the tree
 * changed" walks again at once; if the hint went out before the Convex tree
 * was re-checked, that walk would read the row from before the change and the
 * tab would hold the old tree until the next hint.
 *
 * Sabotage-checked: answering a List before `factsReady` (dropping the check)
 * fails the "facts not whole" case; marking the audiences before the touch
 * fails the order case.
 */

import { describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { FileStore } from "../functions/lib/fileOps";
import { linkTableOf } from "../functions/lib/nodes/linkTable";
import { NO_CHAOS } from "../functions/lib/filesFns/chaosOps";
import * as ops from "../functions/lib/filesFns/treeOps";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";

const WS = "w1" as Id<"workspaces">;
const ARGS = { workspaceId: WS, scope: "private" as const };
const D1_KINDS = new Set(["sweepTree", "touchTree", "treeState"]);

/**
 * An action context in which the Convex tree serves (or not), its facts are
 * whole (or not), and every query, mutation and schedule is recorded.
 */
function fakeCtx(options: { served: boolean; factsReady?: boolean; rows?: string[] }) {
  const events: string[] = [];
  const asked: string[] = [];
  const scheduled: { kind: string }[] = [];
  const ctx = {
    runQuery: vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as never);
      asked.push(name);
      if (name === "functions/nodes:served") return options.served ? { mirror: null } : null;
      if (name === "functions/nodes:listLive") return { rows: (options.rows ?? []).map((path) => ({ path })), cursor: null };
      if (name === "functions/nodeMoves:active") return [];
      if (name === "functions/nodes:paused") return false;
      if (name === "functions/nodeFacts:ready") return options.factsReady === true;
      if (name === "functions/nodeFacts:readiness") return { ready: options.factsReady === true, unparsed: 0 };
      // No note has props yet: a List asked anyway would read every note from the bucket and answer.
      if (name === "functions/nodeFacts:propsAt") return [];
      if (name === "functions/nodeChaos:extras") return options.factsReady === true ? [] : null;
      if (name === "functions/nodeChaos:history") return { then: null };
      if (name === "functions/nodesFeed:walkStart") return null;
      throw new Error(`unexpected query ${name}`);
    }),
    runAction: vi.fn(async (ref: unknown) => {
      throw new Error(`unexpected action ${getFunctionName(ref as never)}`);
    }),
    runMutation: vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as never);
      events.push(name);
      return name.endsWith("nodes:observe") ? { more: false } : null;
    }),
    scheduler: {
      runAfter: vi.fn(async (_delay: number, _ref: unknown, args: { operation: { kind: string } }) => {
        scheduled.push(args.operation);
        events.push(`scheduled:${args.operation.kind}`);
        return "job";
      }),
    },
  };
  return { ctx: ctx as never, events, asked, scheduled };
}

/** Nothing scheduled or asked belongs to the retired D1 tree. */
function expectNoD1(fake: ReturnType<typeof fakeCtx>) {
  expect(fake.scheduled.filter((operation) => D1_KINDS.has(operation.kind))).toEqual([]);
  expect(fake.asked).not.toContain("functions/fastSearch:projectionTargetForWorkspace");
}

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed("1-projects/a.md", "# A\n");
  store.seed("2-areas/b.md", "# B\n");
  return store;
}

describe("which store a walk reads", () => {
  test("where the Convex tree serves, its rows are walked, not the bucket", async () => {
    const fake = fakeCtx({ served: true, rows: ["only/in-convex.md"] });
    const answer = await ops.manifestSource(fake.ctx, { ...ARGS, operation: { kind: "manifest", source: "tree" } }, bucket());
    expect(answer.source).toBe("nodes");
    const listed = await answer.store.list({ prefix: "" });
    expect(listed.objects.map((object) => object.key)).toEqual(["only/in-convex.md"]);
    expectNoD1(fake);
  });

  test("elsewhere the bucket is walked, and no sweep of anything but the Convex tree is started", async () => {
    for (const operation of [{ kind: "manifest", source: "tree" }, { kind: "manifest" }, { kind: "manifest", cursor: "a" }]) {
      const fake = fakeCtx({ served: false });
      const store = bucket();
      expect(await ops.manifestSource(fake.ctx, { ...ARGS, operation }, store)).toEqual({ store, source: "bucket" });
      expectNoD1(fake);
    }
  });

  test("the map carries the facts' link table once they are whole, and reads the index until then", async () => {
    const ready = fakeCtx({ served: true, factsReady: true });
    const withTable = await ops.manifestSource(ready.ctx, { ...ARGS, operation: { kind: "workspaceGraph" } }, bucket());
    expect(linkTableOf(withTable.store)).not.toBeNull();
    expect(ready.scheduled).toEqual([]);

    const behind = fakeCtx({ served: true, factsReady: false });
    const without = await ops.manifestSource(behind.ctx, { ...ARGS, operation: { kind: "workspaceGraph" } }, bucket());
    expect(without.source).toBe("nodes");
    expect(linkTableOf(without.store)).toBeNull();
    // The facts fill is started instead.
    expect(behind.scheduled).toEqual([{ kind: "nodesFactFill", passes: 0 }]);
    expectNoD1(behind);

    const unserved = fakeCtx({ served: false });
    const fromBucket = await ops.manifestSource(unserved.ctx, { ...ARGS, operation: { kind: "workspaceGraph" } }, bucket());
    expect(fromBucket.source).toBe("bucket");
    expect(linkTableOf(fromBucket.store)).toBeNull();
    expect(unserved.scheduled).toEqual([]);
  });
});

describe("a List and the chaos score where the facts cannot answer", () => {
  const list = { kind: "folderNotes" as const, folder: "1-projects", subfolders: true };
  const unavailable = { kind: "folderNotes", available: false, notes: [], cursor: null, missing: [], fill: false };

  test("facts not whole: the List reads its folder from the bucket, and there is no score", async () => {
    const fake = fakeCtx({ served: true, factsReady: false, rows: ["1-projects/a.md"] });
    expect(await ops.runTreeOperation(fake.ctx, { ...ARGS, operation: list }, bucket())).toEqual(unavailable);
    expect(await ops.runTreeOperation(fake.ctx, { ...ARGS, operation: { kind: "chaosScore" } }, bucket())).toEqual(NO_CHAOS);
    expectNoD1(fake);
  });

  test("a tree that does not serve answers the same, without asking the facts", async () => {
    const fake = fakeCtx({ served: false, factsReady: true });
    expect(await ops.runTreeOperation(fake.ctx, { ...ARGS, operation: list }, bucket())).toEqual(unavailable);
    expect(await ops.runTreeOperation(fake.ctx, { ...ARGS, operation: { kind: "chaosScore" } }, bucket())).toEqual(NO_CHAOS);
    expect(fake.asked).not.toContain("functions/nodeFacts:ready");
    expect(fake.asked).not.toContain("functions/nodeChaos:extras");
    expectNoD1(fake);
  });

  test("facts whole: the List answers from them", async () => {
    const fake = fakeCtx({ served: true, factsReady: true, rows: [] });
    const answer = await ops.runTreeOperation(fake.ctx, { ...ARGS, operation: list }, bucket());
    expect(answer).toMatchObject({ kind: "folderNotes", available: true, notes: [] });
  });

  test("only a List and the chaos score are tree operations now", () => {
    expect(ops.isTreeOperation({ kind: "folderNotes" })).toBe(true);
    expect(ops.isTreeOperation({ kind: "chaosScore" })).toBe(true);
    for (const kind of D1_KINDS) expect(ops.isTreeOperation({ kind })).toBe(false);
  });
});

describe("a console change", () => {
  test("is re-checked in the Convex tree before its audiences are told, and schedules nothing else", async () => {
    const fake = fakeCtx({ served: true });
    await ops.keepTreeAndAnnounce(fake.ctx, ARGS, { paths: ["1-projects/a.md"], files: [], audiences: ["private", "team"] }, bucket());
    const observed = fake.events.findIndex((event) => event.endsWith("nodes:observe"));
    const marked = fake.events.findIndex((event) => event.endsWith("treeSignals:markTreeChanged"));
    expect(observed).toBeGreaterThanOrEqual(0);
    expect(marked).toBeGreaterThan(observed);
    const markCall = (fake.ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation.mock.calls.find(
      ([ref]) => getFunctionName(ref as never).endsWith("treeSignals:markTreeChanged"),
    );
    expect(markCall?.[1]).toEqual({ workspaceId: WS, audiences: ["private", "team"] });
    expect(fake.scheduled.filter((operation) => operation.kind !== "nodesFactFill")).toEqual([]);
    expectNoD1(fake);
  });

  test("without the bucket open, the re-check is scheduled and the audiences are told at once", async () => {
    const fake = fakeCtx({ served: true });
    await ops.keepTreeAndAnnounce(fake.ctx, ARGS, { paths: ["a.md"], files: [], audiences: ["private"] });
    expect(fake.scheduled).toEqual([{ kind: "nodesTouch", paths: ["a.md"], files: [] }]);
    expect(fake.events).toContain("functions/treeSignals:markTreeChanged");
    expectNoD1(fake);
  });

  test("a change with no audience tells nobody, and a change naming nothing touches nothing", async () => {
    const fake = fakeCtx({ served: true });
    await ops.keepTreeAndAnnounce(fake.ctx, ARGS, { paths: [], files: [], audiences: [] });
    expect(fake.events).toEqual([]);
    expect(fake.scheduled).toEqual([]);
  });

  test("a deleted note is re-checked as gone and its audiences told, with nothing scheduled for a D1 copy", async () => {
    const fake = fakeCtx({ served: true });
    const store = bucket();
    const before = {
      rules: [{ prefix: "1-projects/", vis: "team" as const }],
      overrides: new Map(),
      text: "",
      etag: null,
      invalid: false,
    };
    await store.delete("1-projects/a.md");
    await ops.announceTreeChange(
      fake.ctx,
      store,
      ARGS,
      { paths: ["1-projects/a.md"], narrows: true, gone: ["1-projects/a.md"] },
      { kind: "deleted", paths: ["1-projects/a.md"] } as never,
      before as never,
    );
    expect(fake.events.some((event) => event.endsWith("nodes:observe"))).toBe(true);
    expect(fake.events.at(-1)).toBe("functions/treeSignals:markTreeChanged");
    expectNoD1(fake);
  });
});
