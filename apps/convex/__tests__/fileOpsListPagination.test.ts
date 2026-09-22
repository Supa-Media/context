import { describe, expect, test } from "vitest";
import { clearVaultBatch } from "../functions/lib/fileOps";

describe("logical-delete listing pagination callers", () => {
  test("clearVaultBatch follows an empty marker page before deleting live keys", async () => {
    const cursors: Array<string | undefined> = [];
    const deleted: string[] = [];
    const store = {
      list: async ({ cursor }: { cursor?: string } = {}) => {
        cursors.push(cursor);
        if (cursor === undefined) {
          return { objects: [], truncated: true, cursor: "after-marker" };
        }
        return {
          objects: [{ key: "live.md" }],
          truncated: false,
        };
      },
      delete: async (key: string) => {
        deleted.push(key);
      },
    };

    const result = await clearVaultBatch(store as never, false);

    expect(result).toEqual({ mode: "deleted", objects: 1, complete: true });
    expect(cursors).toEqual([undefined, "after-marker"]);
    expect(deleted).toEqual(["live.md"]);
  });
});
