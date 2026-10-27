/**
 * The Convex tree's operations are routed to their own runner, and the
 * runFileOperation argument and result validators name them.
 *
 * `isNodesOperation` is what the credential barrier asks before it hands an
 * operation to `runNodesOperation`. A kind it misses falls through to the
 * file operations and is refused there; a kind it wrongly claims is run by the
 * tree's code. Both are pinned here, against the kinds the other operations
 * use. Sabotage-checked: adding "folderNotes" to `isNodesOperation` fails the
 * negative check.
 *
 * The D1 tree's operations (`sweepTree`, `touchTree`, `treeState`) left in
 * phase 7 of the tree migration; the validators no longer accept them, so no
 * scheduler call can name one (`runFileOperation`'s args are typed by them).
 */

import { describe, expect, test } from "vitest";
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
    expect(isNodesOperation({ kind: "nodesFactFill" })).toBe(true);
    expect(isNodesOperation({ kind: "nodesSmallData" })).toBe(true);
  });

  test("leaves every other operation to the barrier's own routes", () => {
    for (const kind of ["folderNotes", "chaosScore", "list", "write", "manifest"]) {
      expect(isNodesOperation({ kind })).toBe(false);
    }
  });
});

describe("runFileOperation's validators name the Convex tree operations", () => {
  test("the operation argument accepts each of them", () => {
    const kinds = kindsOf(operationValidator);
    expect(kinds).toEqual(expect.arrayContaining(["nodesFactFill", "nodesSmallData"]));
  });

  test("the result returns each of their answers", () => {
    const kinds = kindsOf(operationResultValidator);
    expect(kinds).toEqual(expect.arrayContaining(["nodesKept"]));
  });

  test("the D1 tree's sweep, re-check and health are neither accepted nor answered", () => {
    const operations = kindsOf(operationValidator);
    for (const kind of ["sweepTree", "touchTree", "treeState"]) expect(operations).not.toContain(kind);
    const results = kindsOf(operationResultValidator);
    for (const kind of ["treeKept", "treeState"]) expect(results).not.toContain(kind);
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

  test("a scheduled facts fill stops before it reads anything", async () => {
    const { ctx, store, mutations } = pausedCtx();
    const result = await runNodesOperation(ctx as never, { workspaceId, scope: "private", operation: { kind: "nodesFactFill" } }, store as never);
    expect(result).toEqual({ kind: "nodesKept", complete: false });
    expect(mutations).toEqual([]);
  });
});

