import { describe, expect, test } from "vitest";
import {
  planReconcileWaves,
  reconcileMigrationObject,
  reconcileMigrationPage,
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

/**
 * A store that counts what it was asked for and can be told to stall or fail a
 * particular key, so a test can pin both the number of round trips a walk costs
 * and how much of it is in flight at once.
 */
function instrumentedStore(initial: Record<string, number[]> = {}) {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [key, bytes(value)]),
  );
  const gets: string[] = [];
  const puts: string[] = [];
  const gate = new Map<string, () => Promise<void>>();
  const fail = new Map<string, string>();
  let inFlight = 0;
  let peakInFlight = 0;
  const enter = async (key: string) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      const hold = gate.get(key);
      if (hold) await hold();
      const error = fail.get(key);
      if (error) throw new Error(error);
    } finally {
      inFlight -= 1;
    }
  };
  const store: MigrationStore = {
    async get(key) {
      gets.push(key);
      await enter(key);
      const value = values.get(key);
      return value === undefined
        ? null
        : { arrayBuffer: async () => value.slice(0) };
    },
    async put(key, value, options) {
      puts.push(key);
      values.set(key, value.slice(0));
      void options;
      return { etag: "memory" };
    },
    async delete(key) {
      values.delete(key);
    },
  };
  return {
    store,
    values,
    gets,
    puts,
    gate,
    fail,
    peak: () => peakInFlight,
    live: () => inFlight,
  };
}

const ticks = (count: number) => async () => {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
};

describe("an object that is already identical", () => {
  test("is not read back from the destination a second time", async () => {
    const source = instrumentedStore({ "1-projects/foo.md": [1, 2, 3] });
    const target = instrumentedStore({ "1-projects/foo.md": [1, 2, 3] });
    const result = await reconcileMigrationObject({
      source: source.store,
      target: target.store,
      key: "1-projects/foo.md",
      listedFromTarget: false,
      byteCap: 1024,
    });
    expect(result).toEqual({ copied: 1, changes: 0 });
    // The read that proved equality is the only destination read there is.
    expect(target.gets).toEqual(["1-projects/foo.md"]);
    expect(target.puts).toEqual([]);
  });

  test("still reads back whatever it actually wrote", async () => {
    const source = instrumentedStore({ "1-projects/foo.md": [1, 2, 3] });
    const target = instrumentedStore({ "1-projects/foo.md": [9] });
    const result = await reconcileMigrationObject({
      source: source.store,
      target: target.store,
      key: "1-projects/foo.md",
      listedFromTarget: false,
      byteCap: 1024,
    });
    expect(result).toEqual({ copied: 1, changes: 1 });
    expect(target.puts).toEqual(["1-projects/foo.md"]);
    // Once to compare, once to verify the write landed.
    expect(target.gets).toEqual(["1-projects/foo.md", "1-projects/foo.md"]);
  });
});

describe("splitting a listed page into waves", () => {
  const sized = (count: number, size: number) =>
    Array.from({ length: count }, (_, index) => ({ key: `k${index}`, size }));

  test("closes a wave at the count bound", () => {
    const waves = planReconcileWaves(sized(10, 1), {
      maxWidth: 4,
      byteBudget: 1_000_000,
    });
    expect(waves.map((wave) => wave.length)).toEqual([4, 4, 2]);
  });

  test("closes a wave at the byte bound before the count bound", () => {
    const waves = planReconcileWaves(sized(6, 400), {
      maxWidth: 16,
      byteBudget: 1000,
    });
    expect(waves.map((wave) => wave.length)).toEqual([2, 2, 2]);
  });

  test("gives an object larger than the whole budget a wave of its own", () => {
    const waves = planReconcileWaves(
      [
        { key: "small.md", size: 10 },
        { key: "huge.bin", size: 5000 },
        { key: "after.md", size: 10 },
      ],
      { maxWidth: 16, byteBudget: 1000 },
    );
    // Never starved out of being reconciled, and never batched with anything.
    expect(waves).toEqual([
      [{ key: "small.md", size: 10 }],
      [{ key: "huge.bin", size: 5000 }],
      [{ key: "after.md", size: 10 }],
    ]);
  });

  test("falls back to the count bound when a listing reports no sizes", () => {
    const waves = planReconcileWaves(
      Array.from({ length: 5 }, (_, index) => ({ key: `k${index}` })),
      { maxWidth: 2, byteBudget: 1000 },
    );
    expect(waves.map((wave) => wave.length)).toEqual([2, 2, 1]);
  });
});

describe("reconciling a page in waves", () => {
  const page = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      key: `note-${index}.md`,
      size: 1,
    }));

  function seeded(count: number) {
    return Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`note-${index}.md`, [index]]),
    );
  }

  test("reconciles more than one object at a time, but never more than the width", async () => {
    const source = instrumentedStore(seeded(12));
    const target = instrumentedStore();
    for (const object of page(12)) source.gate.set(object.key, ticks(3));
    const result = await reconcileMigrationPage({
      source: source.store,
      target: target.store,
      objects: page(12),
      listedFromTarget: false,
      byteCap: 1024,
      maxWidth: 4,
      byteBudget: 1_000_000,
    });
    expect(result).toEqual({ copied: 12, changes: 12 });
    expect(source.peak()).toBe(4);
  });

  test("totals every wave rather than only the last", async () => {
    const source = instrumentedStore(seeded(9));
    const target = instrumentedStore(seeded(9));
    const result = await reconcileMigrationPage({
      source: source.store,
      target: target.store,
      objects: page(9),
      listedFromTarget: false,
      byteCap: 1024,
      maxWidth: 2,
      byteBudget: 1_000_000,
    });
    // Every object already identical: all counted, none rewritten.
    expect(result).toEqual({ copied: 9, changes: 0 });
    expect(target.puts).toEqual([]);
  });

  test("raises the earliest listed failure, not whichever landed first", async () => {
    const source = instrumentedStore(seeded(4));
    const target = instrumentedStore();
    // The earlier key fails slowly; the later one fails immediately. A serial
    // walk would have stopped at the earlier one, so this must too.
    source.gate.set("note-0.md", ticks(8));
    source.fail.set("note-0.md", "SLOW_FIRST");
    source.fail.set("note-2.md", "FAST_SECOND");
    await expect(
      reconcileMigrationPage({
        source: source.store,
        target: target.store,
        objects: page(4),
        listedFromTarget: false,
        byteCap: 1024,
        maxWidth: 4,
        byteBudget: 1_000_000,
      }),
    ).rejects.toThrow("SLOW_FIRST");
  });

  test("waits for the whole wave to settle before the page fails", async () => {
    const source = instrumentedStore(seeded(4));
    const target = instrumentedStore();
    // The first listed object fails at once; a later one is still reading.
    source.fail.set("note-0.md", "FAILS_FIRST");
    source.gate.set("note-3.md", ticks(10));
    source.fail.set("note-3.md", "STILL_IN_FLIGHT");
    await expect(
      reconcileMigrationPage({
        source: source.store,
        target: target.store,
        objects: page(4),
        listedFromTarget: false,
        byteCap: 1024,
        maxWidth: 4,
        byteBudget: 1_000_000,
      }),
    ).rejects.toThrow("FAILS_FIRST");
    // Throwing the moment the first sibling rejected would leave the others
    // reading on against a page the caller has already given up on, and their
    // rejections landing after nothing is waiting for them.
    expect(source.live()).toBe(0);
  });

  test("removes target-only keys when the destination is what was listed", async () => {
    const source = instrumentedStore({ "kept.md": [1] });
    const target = instrumentedStore({ "kept.md": [1], "gone.md": [2] });
    const result = await reconcileMigrationPage({
      source: source.store,
      target: target.store,
      objects: [
        { key: "kept.md", size: 1 },
        { key: "gone.md", size: 1 },
      ],
      listedFromTarget: true,
      byteCap: 1024,
      maxWidth: 4,
      byteBudget: 1_000_000,
    });
    expect(result).toEqual({ copied: 1, changes: 1 });
    expect(target.values.has("gone.md")).toBe(false);
    expect(source.values.has("kept.md")).toBe(true);
  });
});
