/**
 * The Convex tree's operations are routed to their own runner, and the
 * runFileOperation argument and result validators name them.
 *
 * `isNodesOperation` is what the credential barrier asks before it hands an
 * operation to `runNodesOperation`. A kind it misses falls through to the
 * file operations and is refused there; a kind it wrongly claims is run by the
 * tree's code. Both are pinned here, against the kinds the other operations
 * use. Sabotage-checked: adding "treeState" to `isNodesOperation` fails the
 * negative check.
 */

import { describe, expect, test } from "vitest";
import { getFunctionName } from "convex/server";
import { memoryStore } from "./storeStub.helpers";
import { NODE_PARITY_CONFIRM_MS } from "../functions/lib/nodes/table";
import { isNodesOperation, runNodesOperation } from "../functions/lib/nodes/run";
import { operationResultValidator, operationValidator } from "../functions/lib/filesFns/operationValidators";

/** The `kind` literal of each member of a union validator, read from its JSON form. */
function kindsOf(validator: unknown): string[] {
  const json = (validator as { json: unknown }).json as {
    value: Array<{ value: Record<string, { fieldType: { value?: unknown } }> }>;
  };
  return json.value.map((member) => String(member.value.kind.fieldType.value));
}

describe("isNodesOperation", () => {
  test("claims the three Convex tree operations", () => {
    expect(isNodesOperation({ kind: "nodesSweep" })).toBe(true);
    expect(isNodesOperation({ kind: "nodesTouch" })).toBe(true);
    expect(isNodesOperation({ kind: "nodesParity" })).toBe(true);
    expect(isNodesOperation({ kind: "nodesPrivacyExport" })).toBe(true);
  });

  test("leaves every other operation to the barrier's own routes", () => {
    for (const kind of ["sweepTree", "touchTree", "treeState", "treeChanges", "list", "write", "manifest"]) {
      expect(isNodesOperation({ kind })).toBe(false);
    }
  });
});

describe("runFileOperation's validators name the Convex tree operations", () => {
  test("the operation argument accepts each of them", () => {
    const kinds = kindsOf(operationValidator);
    expect(kinds).toEqual(expect.arrayContaining(["nodesSweep", "nodesTouch", "nodesParity", "nodesPrivacyExport"]));
  });

  test("the result returns each of their answers", () => {
    const kinds = kindsOf(operationResultValidator);
    expect(kinds).toEqual(expect.arrayContaining(["nodesKept", "nodesParity"]));
  });
});

describe("a paused migration", () => {
  // Every query answers "paused"; a store that is listed fails the test.
  function pausedCtx() {
    const mutations: unknown[] = [];
    const ctx = {
      runQuery: async () => true,
      runMutation: async (_ref: unknown, args: unknown) => {
        mutations.push(args);
        return null;
      },
      scheduler: { runAfter: async () => "job" },
    };
    const store = {
      list: async () => {
        throw new Error("listed the bucket while paused");
      },
      get: async () => null,
    };
    return { ctx, store, mutations };
  }
  const workspaceId = "w" as never;

  test("a scheduled sweep stops before it lists anything", async () => {
    const { ctx, store, mutations } = pausedCtx();
    const result = await runNodesOperation(ctx as never, { workspaceId, scope: "private", operation: { kind: "nodesSweep" } }, store as never);
    expect(result).toEqual({ kind: "nodesKept", complete: false });
    expect(mutations).toEqual([]);
  });

  test("a re-check only marks the tree dirty, so resuming catches it up", async () => {
    const { ctx, store, mutations } = pausedCtx();
    const result = await runNodesOperation(
      ctx as never,
      { workspaceId, scope: "private", operation: { kind: "nodesTouch", paths: ["a"], files: [] } },
      store as never,
    );
    expect(result).toEqual({ kind: "nodesKept", complete: false });
    expect(mutations).toEqual([{ workspaceId }]);
  });
});

describe("a parity check that finds differences", () => {
  // The bucket holds one note the tree has never heard of: a difference.
  function parityCtx() {
    const mutations: { name: string; args: unknown }[] = [];
    const scheduled: { delay: number; args: unknown }[] = [];
    const ctx = {
      runQuery: async (ref: unknown) => {
        const name = getFunctionName(ref as never);
        if (name.endsWith("nodeMoves:active")) return [];
        if (name.endsWith("nodes:listLive")) return { rows: [], cursor: null };
        if (name.endsWith("nodes:privacy")) return null;
        throw new Error(`unexpected query ${name}`);
      },
      runMutation: async (ref: unknown, args: unknown) => {
        mutations.push({ name: getFunctionName(ref as never), args });
        return null;
      },
      scheduler: {
        runAfter: async (delay: number, _ref: unknown, args: unknown) => {
          scheduled.push({ delay, args });
          return "job";
        },
      },
    };
    const store = memoryStore();
    return { ctx, store, mutations, scheduled };
  }
  const workspaceId = "w" as never;

  test("is asked once more before it is recorded, so a write in flight never stops the tree serving", async () => {
    const { ctx, store, mutations, scheduled } = parityCtx();
    await store.put("1-projects/a.md", "# a");
    const result = await runNodesOperation(ctx as never, { workspaceId, scope: "private", operation: { kind: "nodesParity" } }, store as never);
    expect(result).toMatchObject({ kind: "nodesParity" });
    expect((result as { mismatches: number }).mismatches).toBeGreaterThan(0);
    expect(mutations.filter((call) => call.name.endsWith("saveParity"))).toEqual([]);
    expect(scheduled).toEqual([
      { delay: NODE_PARITY_CONFIRM_MS, args: { workspaceId, scope: "private", operation: { kind: "nodesParity", confirm: true } } },
    ]);
  });

  test("the confirming check records what it finds", async () => {
    const { ctx, store, mutations, scheduled } = parityCtx();
    await store.put("1-projects/a.md", "# a");
    await runNodesOperation(ctx as never, { workspaceId, scope: "private", operation: { kind: "nodesParity", confirm: true } }, store as never);
    expect(scheduled).toEqual([]);
    const saved = mutations.filter((call) => call.name.endsWith("saveParity"));
    expect(saved).toHaveLength(1);
    expect((saved[0]!.args as { parity: { mismatches: number } }).parity.mismatches).toBeGreaterThan(0);
  });

  test("a matching check is recorded at once", async () => {
    const { ctx, store, mutations, scheduled } = parityCtx();
    await runNodesOperation(ctx as never, { workspaceId, scope: "private", operation: { kind: "nodesParity" } }, store as never);
    expect(scheduled).toEqual([]);
    expect(mutations.filter((call) => call.name.endsWith("saveParity"))).toHaveLength(1);
describe("the privacy export", () => {
  const workspaceId = "w" as never;
  const operation = { kind: "nodesPrivacyExport" } as const;
  function exportCtx(owed: boolean) {
    const exports: number[] = [];
    // The only query asked is whether the export is owed; a pause is never consulted.
    const ctx = { runQuery: async () => owed, runMutation: async () => null, scheduler: { runAfter: async () => "job" } };
    const store = { exportPrivacy: async () => exports.push(1), list: async () => ({ objects: [] }), get: async () => null };
    return { ctx, store, exports };
  }

  test("writes the file while it is owed", async () => {
    const { ctx, store, exports } = exportCtx(true);
    const result = await runNodesOperation(ctx as never, { workspaceId, scope: "private", operation }, store as never);
    expect(result).toEqual({ kind: "nodesKept", complete: true });
    expect(exports).toEqual([1]);
  });

  test("writes nothing once the export settled", async () => {
    const { ctx, store, exports } = exportCtx(false);
    await runNodesOperation(ctx as never, { workspaceId, scope: "private", operation }, store as never);
    expect(exports).toEqual([]);
  });
});
