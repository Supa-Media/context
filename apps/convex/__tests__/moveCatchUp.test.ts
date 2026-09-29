/**
 * Catching up after a storage move switches over.
 *
 * A move checks every file twice and then swaps the binding, but a writer that
 * picked up the old storage a moment before the swap (an agent's turn, a file
 * operation, a queued job) can still land its write in the old bucket after
 * the last check read that file. Nothing reads the old bucket again, so that
 * write would be lost. The catch-up passes after the swap read the old bucket
 * for files changed since the last check began and bring them across, and the
 * one rule they never break is that a file in the new bucket is never
 * overwritten or deleted: when both sides changed, the old side's version is
 * kept beside it as `name (saved during the move).ext`.
 *
 * ## Sabotage record
 *
 * Writing the late version over the new bucket's file instead of beside it
 * lost the edit made after the switch, failing "both sides changed". Dropping
 * the `since` filter made the pass copy a file edited only on the new side,
 * failing "a file changed only after the switch". Treating a missing
 * LastModified as old skipped a late write, failing the undated test. Letting
 * a deletion marker through deleted the new bucket's note, failing the
 * deletion test. Sending the create without `absent` overwrote a file created
 * between the read and the write, failing the race test.
 */

import { describe, expect, test } from "vitest";
import {
  catchUpCopyKey,
  catchUpObject,
  catchUpPage,
  type CatchUpStore,
} from "../functions/lib/moveCatchUp";

const BEFORE = Date.UTC(2026, 8, 29, 12, 0);
const SINCE = Date.UTC(2026, 8, 29, 12, 10);
const AFTER = Date.UTC(2026, 8, 29, 12, 20);

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const text = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer);

interface Stored {
  body: ArrayBuffer;
  contentType: string;
  uploaded: Date;
}

/** An in-memory bucket with the adapter's contract: `absent` fails with null. */
function bucket(initial: Record<string, [string, number] | [string, number, string]> = {}) {
  const objects = new Map<string, Stored>();
  for (const [key, [body, at, contentType]] of Object.entries(initial)) {
    objects.set(key, {
      body: bytes(body),
      contentType: contentType ?? "text/markdown; charset=utf-8",
      uploaded: new Date(at),
    });
  }
  const writes: string[] = [];
  const deletes: string[] = [];
  let beforeCreate: ((key: string) => void) | undefined;
  const store: CatchUpStore & { delete(key: string): Promise<void> } = {
    async list() {
      return {
        objects: [...objects.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => ({ key, size: value.body.byteLength, uploaded: value.uploaded })),
        truncated: false,
      };
    },
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        contentType: value.contentType,
        uploaded: value.uploaded,
        arrayBuffer: async () => value.body.slice(0),
      };
    },
    async put(key, value, options) {
      beforeCreate?.(key);
      if (options.onlyIf?.absent === true && objects.has(key)) return null;
      writes.push(key);
      objects.set(key, { body: value.slice(0), contentType: options.contentType, uploaded: new Date(AFTER) });
      return { etag: `e-${writes.length}` };
    },
    async delete(key) {
      deletes.push(key);
      objects.delete(key);
    },
  };
  return {
    store,
    objects,
    writes,
    deletes,
    read: (key: string) => (objects.has(key) ? text(objects.get(key)!.body) : null),
    set: (key: string, body: string, at: number) =>
      objects.set(key, { body: bytes(body), contentType: "text/markdown; charset=utf-8", uploaded: new Date(at) }),
    onCreate(hook: (key: string) => void) {
      beforeCreate = hook;
    },
  };
}

const CAP = 1024 * 1024;

async function run(source: ReturnType<typeof bucket>, target: ReturnType<typeof bucket>) {
  const page = await source.store.list({});
  return catchUpPage({
    source: source.store,
    target: target.store,
    objects: page.objects,
    since: SINCE,
    byteCap: CAP,
    maxWidth: 4,
  });
}

describe("the name a late version is kept under", () => {
  test("sits beside the note, numbered after the first", () => {
    expect(catchUpCopyKey("1-projects/plan.md", 1)).toBe("1-projects/plan (saved during the move).md");
    expect(catchUpCopyKey("1-projects/plan.md", 2)).toBe("1-projects/plan (saved during the move 2).md");
    expect(catchUpCopyKey("notes.v2/README", 1)).toBe("notes.v2/README (saved during the move)");
    expect(catchUpCopyKey(".hidden", 1)).toBe(".hidden (saved during the move)");
  });
});

describe("catching up after the switch", () => {
  test("a file written to the old bucket after the last check is brought across", async () => {
    const source = bucket({ "0-inbox/late.md": ["written late", AFTER] });
    const target = bucket();
    await expect(run(source, target)).resolves.toMatchObject({ copied: 1, keptBeside: 0 });
    expect(target.read("0-inbox/late.md")).toBe("written late");
  });

  test("both sides changed: the new bucket's file is kept and the late one sits beside it", async () => {
    const source = bucket({ "plan.md": ["late edit in the old bucket", AFTER] });
    const target = bucket({ "plan.md": ["edit made after the switch", AFTER] });
    await expect(run(source, target)).resolves.toMatchObject({ copied: 0, keptBeside: 1 });
    expect(target.read("plan.md")).toBe("edit made after the switch");
    expect(target.read("plan (saved during the move).md")).toBe("late edit in the old bucket");
  });

  test("a file changed only after the switch, in the new bucket, is left alone", async () => {
    const source = bucket({ "plan.md": ["what the move verified", BEFORE] });
    const target = bucket({ "plan.md": ["edited after the switch", AFTER] });
    await expect(run(source, target)).resolves.toMatchObject({ copied: 0, keptBeside: 0, checked: 0 });
    expect(target.writes).toEqual([]);
  });

  test("an identical file is not written again", async () => {
    const source = bucket({ "plan.md": ["same", AFTER] });
    const target = bucket({ "plan.md": ["same", BEFORE] });
    await expect(run(source, target)).resolves.toMatchObject({ copied: 0, keptBeside: 0, checked: 1 });
    expect(target.writes).toEqual([]);
  });

  test("a file with no date is treated as late rather than skipped", async () => {
    const source = bucket({ "undated.md": ["no LastModified from this provider", 0] });
    const target = bucket();
    await run(source, target);
    expect(target.read("undated.md")).toBe("no LastModified from this provider");
  });

  test("a deletion in the old bucket never deletes or overwrites in the new one", async () => {
    const source = bucket({
      "plan.md": ["", AFTER, "application/x-context-logical-tombstone"],
    });
    const target = bucket({ "plan.md": ["still here", BEFORE] });
    await expect(run(source, target)).resolves.toMatchObject({ copied: 0, keptBeside: 0 });
    expect(target.read("plan.md")).toBe("still here");
    expect(target.writes).toEqual([]);
    expect(target.deletes).toEqual([]);
  });

  test("a file created in the new bucket between the read and the write is not overwritten", async () => {
    const source = bucket({ "plan.md": ["late in the old bucket", AFTER] });
    const target = bucket();
    target.onCreate((key) => {
      if (key === "plan.md" && !target.objects.has(key)) target.set(key, "someone got there first", AFTER);
    });
    await run(source, target);
    expect(target.read("plan.md")).toBe("someone got there first");
    expect(target.read("plan (saved during the move).md")).toBe("late in the old bucket");
  });

  test("Context's own plumbing is copied when missing and never duplicated", async () => {
    const source = bucket({
      ".context/collaboration/a.bin": ["update a", AFTER],
      ".context/search/state.json": ["old side", AFTER],
    });
    const target = bucket({ ".context/search/state.json": ["new side", AFTER] });
    await run(source, target);
    expect(target.read(".context/collaboration/a.bin")).toBe("update a");
    expect(target.read(".context/search/state.json")).toBe("new side");
    expect([...target.objects.keys()].some((key) => key.includes("saved during the move"))).toBe(false);
  });

  test("running again adds nothing, and a second late version gets the next name", async () => {
    const source = bucket({ "plan.md": ["late one", AFTER] });
    const target = bucket({ "plan.md": ["new side", AFTER] });
    await run(source, target);
    await run(source, target);
    expect(target.writes).toEqual(["plan (saved during the move).md"]);

    source.set("plan.md", "late two", AFTER + 1);
    await run(source, target);
    expect(target.read("plan (saved during the move).md")).toBe("late one");
    expect(target.read("plan (saved during the move 2).md")).toBe("late two");
    expect(target.read("plan.md")).toBe("new side");
  });

  test("a file too large to move is counted and left in the old bucket", async () => {
    const source = bucket({ "big.bin": ["x".repeat(64), AFTER, "application/octet-stream"] });
    const target = bucket();
    const page = await source.store.list({});
    await expect(
      catchUpPage({
        source: source.store,
        target: target.store,
        objects: page.objects,
        since: SINCE,
        byteCap: 16,
        maxWidth: 4,
      }),
    ).resolves.toMatchObject({ tooLarge: 1, copied: 0 });
    expect(target.writes).toEqual([]);
  });

  test("one file failing does not stop the rest of the page", async () => {
    const source = bucket({ "a.md": ["a", AFTER], "b.md": ["b", AFTER] });
    const target = bucket();
    const failing: CatchUpStore = {
      ...target.store,
      async get(key) {
        if (key === "a.md") throw new Error("network");
        return target.store.get(key);
      },
    };
    const page = await source.store.list({});
    await expect(
      catchUpPage({
        source: source.store,
        target: failing,
        objects: page.objects,
        since: SINCE,
        byteCap: CAP,
        maxWidth: 4,
      }),
    ).resolves.toMatchObject({ failed: 1, copied: 1 });
    expect(target.read("b.md")).toBe("b");
  });

  test("a file gone from the old bucket by the time it is read is skipped", async () => {
    const source = bucket();
    const target = bucket();
    await expect(
      catchUpObject({ source: source.store, target: target.store, key: "gone.md", byteCap: CAP }),
    ).resolves.toBe("gone");
  });
});
