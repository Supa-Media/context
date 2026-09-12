import { describe, expect, test } from "vitest";
import {
  reconcileMigrationObject,
  type MigrationStore,
} from "../functions/lib/managedMigration";

function bytes(values: number[]): ArrayBuffer {
  return Uint8Array.from(values).buffer;
}

function memoryStore(initial: Record<string, number[]> = {}, corruptWrites = false) {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [key, bytes(value)]),
  );
  const contentTypes = new Map<string, string>();
  const store: MigrationStore = {
    async get(key) {
      const value = values.get(key);
      return value === undefined ? null : { arrayBuffer: async () => value.slice(0) };
    },
    async put(key, value, options) {
      values.set(key, corruptWrites ? bytes([0]) : value.slice(0));
      contentTypes.set(key, options.contentType);
      return { etag: "memory" };
    },
    async delete(key) {
      values.delete(key);
    },
  };
  return { store, values, contentTypes };
}

describe("one managed-storage migration object", () => {
  test("copies binary bytes exactly and verifies the stored result", async () => {
    const source = memoryStore({ "attachments/photo.bin": [0, 255, 7, 128] });
    const target = memoryStore();
    const result = await reconcileMigrationObject({
      source: source.store,
      target: target.store,
      key: "attachments/photo.bin",
      listedFromTarget: false,
      byteCap: 1024,
    });
    expect(result).toEqual({ copied: 1, changes: 1 });
    expect([...new Uint8Array(target.values.get("attachments/photo.bin")!)]).toEqual([
      0, 255, 7, 128,
    ]);
    expect(target.contentTypes.get("attachments/photo.bin")).toBe(
      "application/octet-stream",
    );
  });

  test("removes a target-only key without touching the source", async () => {
    const source = memoryStore();
    const target = memoryStore({ "deleted.md": [1] });
    expect(
      await reconcileMigrationObject({
        source: source.store,
        target: target.store,
        key: "deleted.md",
        listedFromTarget: true,
        byteCap: 1024,
      }),
    ).toEqual({ copied: 0, changes: 1 });
    expect(target.values.has("deleted.md")).toBe(false);
    expect(source.values.size).toBe(0);
  });

  test("fails instead of advancing when the destination changes the bytes", async () => {
    const source = memoryStore({ "note.md": [1, 2, 3] });
    const target = memoryStore({}, true);
    await expect(
      reconcileMigrationObject({
        source: source.store,
        target: target.store,
        key: "note.md",
        listedFromTarget: false,
        byteCap: 1024,
      }),
    ).rejects.toThrow("VERIFY_FAILED");
  });
});
