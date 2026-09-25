import { describe, expect, test } from "vitest";
import type {
  FileOperation,
  OperationResult,
} from "../functions/lib/filesFns/operationTypes";
import { operationTouchesWebsite } from "../functions/lib/websites/changes";

const written: OperationResult = {
  kind: "written",
  path: "irrelevant.md",
  etag: "etag",
  bytes: 1,
  conflictCheck: "conditional",
  forms: { created: [], occupied: [] },
};

function touches(operation: FileOperation, result = written): boolean {
  return operationTouchesWebsite(operation, result);
}

describe("website derivative invalidation", () => {
  test("covers direct writes and both sides of moves", () => {
    expect(
      touches({ kind: "write", path: "website/index.md", text: "page" }),
    ).toBe(true);
    expect(
      touches({ kind: "move", from: "notes/page.md", to: "website/page.md" }),
    ).toBe(true);
    expect(
      touches({ kind: "move", from: "website/page.md", to: "notes/page.md" }),
    ).toBe(true);
    expect(
      touches({
        kind: "delete",
        path: "/website/page.md",
        confirmation: "page",
      }),
    ).toBe(true);
  });

  test("uses landed paths when an operation reports a move", () => {
    expect(
      touches(
        { kind: "duplicate", path: "notes/page.md" },
        {
          kind: "moved",
          from: "notes/page.md",
          to: "website/page.md",
          paths: ["website/page.md"],
        },
      ),
    ).toBe(true);
  });

  test("covers destructive vault writes without invalidating reads", () => {
    expect(touches({ kind: "clearVault", countOnly: false })).toBe(true);
    expect(touches({ kind: "clearVault", countOnly: true })).toBe(false);
    expect(touches({ kind: "read", path: "website/index.md" })).toBe(false);
    expect(
      touches({ kind: "write", path: "notes/page.md", text: "note" }),
    ).toBe(false);
  });
});
