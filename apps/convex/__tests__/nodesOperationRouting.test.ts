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
import { isNodesOperation } from "../functions/lib/nodes/run";
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
    expect(kinds).toEqual(expect.arrayContaining(["nodesSweep", "nodesTouch", "nodesParity"]));
  });

  test("the result returns each of their answers", () => {
    const kinds = kindsOf(operationResultValidator);
    expect(kinds).toEqual(expect.arrayContaining(["nodesKept", "nodesParity"]));
  });
});
