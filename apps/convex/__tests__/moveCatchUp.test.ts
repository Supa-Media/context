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
 * kept beside it as a note of its own, `name (saved during the move).ext`: a
 * new note id, its own key, and a row beside the original's. A note's name is
 * its tree row, so a copy kept under a raw key with no row would be invisible.
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
 * between the read and the write, failing the race test. Keeping the late
 * version at a raw `(saved during the move)` key instead of a new id with a
 * row left the beside note with no row, failing "both sides changed".
 * Passing over a beside name that already holds these bytes wrote a second
 * copy on the second pass, failing "running again adds nothing".
 */

import { describe, expect, test } from "vitest";
import {
  besideName,
  catchUpObject,
  catchUpPage,
  noteIdOfKey,
  type CatchUpRows,
  type CatchUpStore,
} from "../functions/lib/moveCatchUp";
import { idKeyFor, isNoteId } from "../functions/lib/nodes/noteIds";

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

const PLAN_ID = "0190a000-0000-7000-8000-0000000000a1";
const PLAN = idKeyFor(PLAN_ID, "projects/plan.md");

/**
 * A tree with the production rule for beside names: one row per path, keyed
 * at its storage key. `adopt` refuses a name a row already holds.
 */
function tree(initial: Record<string, string> = { "projects/plan.md": PLAN }) {
  const rows = new Map(Object.entries(initial));
  const adopted: { path: string; key: string; original: string }[] = [];
  let beforeAdopt: ((path: string) => void) | undefined;
  const api: CatchUpRows = {
    async besideOf(key) {
      const path = [...rows.entries()].find(([, held]) => held === key)?.[0];
      if (path === undefined) return null;
      const slots = Array.from({ length: 20 }, (_, index) => {
        const held = rows.get(besideName(path, index + 1));
        return held === undefined ? ({ free: true } as const) : ({ free: false, key: held } as const);
      });
      return { path, slots };
    },
    async adopt(copy) {
      beforeAdopt?.(copy.path);
      if (rows.has(copy.path) || ![...rows.values()].includes(copy.original)) return false;
      if (copy.key !== idKeyFor(copy.noteId, copy.path) || !isNoteId(copy.noteId)) return false;
      rows.set(copy.path, copy.key);
      adopted.push({ path: copy.path, key: copy.key, original: copy.original });
      return true;
    },
  };
  return {
    api,
    rows,
    adopted,
    keyAt: (path: string) => rows.get(path) ?? null,
    onAdopt(hook: (path: string) => void) {
      beforeAdopt = hook;
    },
  };
}

async function run(
  source: ReturnType<typeof bucket>,
  target: ReturnType<typeof bucket>,
  rows: ReturnType<typeof tree> = tree(),
) {
  const page = await source.store.list({});
  return catchUpPage({
    source: source.store,
    target: target.store,
    rows: rows.api,
    objects: page.objects,
    since: SINCE,
    byteCap: CAP,
    maxWidth: 4,
  });
}

describe("the name a late version is kept under", () => {
  test("sits beside the note, numbered after the first", () => {
    expect(besideName("projects/plan.md", 1)).toBe("projects/plan (saved during the move).md");
    expect(besideName("projects/plan.md", 2)).toBe("projects/plan (saved during the move 2).md");
    expect(besideName("notes.v2/README", 1)).toBe("notes.v2/README (saved during the move)");
    expect(besideName(".hidden", 1)).toBe(".hidden (saved during the move)");
  });

  test("only an id key names a note", () => {
    expect(noteIdOfKey(PLAN)).toBe(PLAN_ID);
    expect(noteIdOfKey(`files/${PLAN_ID}.png`)).toBe(PLAN_ID);
    expect(noteIdOfKey(`files/${PLAN_ID}`)).toBe(PLAN_ID);
    expect(noteIdOfKey("projects/plan.md")).toBeNull();
    expect(noteIdOfKey(`notes/${PLAN_ID} (saved during the move).md`)).toBeNull();
    expect(noteIdOfKey(`notes/sub/${PLAN_ID}.md`)).toBeNull();
    expect(noteIdOfKey("notes/not-an-id.md")).toBeNull();
  });
});

describe("catching up after the switch", () => {
  test("a file written to the old bucket after the last check is brought across", async () => {
    const source = bucket({ "0-inbox/late.md": ["written late", AFTER] });
    const target = bucket();
    await expect(run(source, target)).resolves.toMatchObject({ copied: 1, keptBeside: 0 });
    expect(target.read("0-inbox/late.md")).toBe("written late");
  });

  test("both sides changed: the new bucket's note is kept and the late one is a note beside it", async () => {
    const source = bucket({ [PLAN]: ["late edit in the old bucket", AFTER] });
    const target = bucket({ [PLAN]: ["edit made after the switch", AFTER] });
    const rows = tree();
    await expect(run(source, target, rows)).resolves.toMatchObject({ copied: 0, keptBeside: 1 });
    expect(target.read(PLAN)).toBe("edit made after the switch");
    // The late version is a note someone can open: a row beside the original, keyed at a new id of its own.
    const copyKey = rows.keyAt("projects/plan (saved during the move).md");
    expect(copyKey).toMatch(/^notes\/[0-9a-f-]{36}\.md$/);
    expect(copyKey).not.toBe(PLAN);
    expect(target.read(copyKey!)).toBe("late edit in the old bucket");
    expect(rows.adopted).toEqual([{ path: "projects/plan (saved during the move).md", key: copyKey, original: PLAN }]);
    expect([...target.objects.keys()].some((key) => key.includes("saved during the move"))).toBe(false);
  });

  test("an attachment's late version keeps its extension under its new id", async () => {
    const photo = idKeyFor(PLAN_ID, "projects/photo.png");
    const source = bucket({ [photo]: ["late pixels", AFTER, "application/octet-stream"] });
    const target = bucket({ [photo]: ["new pixels", AFTER, "application/octet-stream"] });
    const rows = tree({ "projects/photo.png": photo });
    await run(source, target, rows);
    const copyKey = rows.keyAt("projects/photo (saved during the move).png");
    expect(copyKey).toMatch(/^files\/[0-9a-f-]{36}\.png$/);
    expect(target.read(copyKey!)).toBe("late pixels");
  });

  test("a late version of a note no live row holds is not carried", async () => {
    const source = bucket({ [PLAN]: ["late edit of a note trashed since", AFTER] });
    const target = bucket({ [PLAN]: ["what the new bucket has", AFTER] });
    const rows = tree({});
    await expect(run(source, target, rows)).resolves.toMatchObject({ keptBeside: 0, noRow: 1 });
    expect(target.writes).toEqual([]);
  });

  test("a path key that differs is left: nothing reads a frozen path copy", async () => {
    const source = bucket({ "projects/plan.md": ["late path copy", AFTER] });
    const target = bucket({ "projects/plan.md": ["frozen copy", AFTER] });
    await expect(run(source, target)).resolves.toMatchObject({ copied: 0, keptBeside: 0 });
    expect(target.writes).toEqual([]);
  });

  test("a beside name taken between the look and the row is never overwritten", async () => {
    const source = bucket({ [PLAN]: ["late", AFTER] });
    const target = bucket({ [PLAN]: ["new side", AFTER] });
    const rows = tree();
    rows.onAdopt((path) => {
      if (!rows.rows.has(path)) rows.rows.set(path, "notes/someone-else.md");
    });
    await expect(run(source, target, rows)).resolves.toMatchObject({ keptBeside: 0, failed: 1 });
    expect(rows.keyAt("projects/plan (saved during the move).md")).toBe("notes/someone-else.md");
    expect(rows.adopted).toEqual([]);
  });

  test("a file changed only after the switch, in the new bucket, is left alone", async () => {
    const source = bucket({ [PLAN]: ["what the move verified", BEFORE] });
    const target = bucket({ [PLAN]: ["edited after the switch", AFTER] });
    await expect(run(source, target)).resolves.toMatchObject({ copied: 0, keptBeside: 0, checked: 0 });
    expect(target.writes).toEqual([]);
  });

  test("an identical file is not written again", async () => {
    const source = bucket({ [PLAN]: ["same", AFTER] });
    const target = bucket({ [PLAN]: ["same", BEFORE] });
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
      [PLAN]: ["", AFTER, "application/x-context-logical-tombstone"],
    });
    const target = bucket({ [PLAN]: ["still here", BEFORE] });
    await expect(run(source, target)).resolves.toMatchObject({ copied: 0, keptBeside: 0 });
    expect(target.read(PLAN)).toBe("still here");
    expect(target.writes).toEqual([]);
    expect(target.deletes).toEqual([]);
  });

  test("a file created in the new bucket between the read and the write is not overwritten", async () => {
    const source = bucket({ [PLAN]: ["late in the old bucket", AFTER] });
    const target = bucket();
    const rows = tree();
    target.onCreate((key) => {
      if (key === PLAN && !target.objects.has(key)) target.set(key, "someone got there first", AFTER);
    });
    await run(source, target, rows);
    expect(target.read(PLAN)).toBe("someone got there first");
    expect(target.read(rows.keyAt("projects/plan (saved during the move).md")!)).toBe("late in the old bucket");
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
    const source = bucket({ [PLAN]: ["late one", AFTER] });
    const target = bucket({ [PLAN]: ["new side", AFTER] });
    const rows = tree();
    await run(source, target, rows);
    await run(source, target, rows);
    expect(rows.adopted.map((copy) => copy.path)).toEqual(["projects/plan (saved during the move).md"]);
    expect(target.writes).toHaveLength(1);

    source.set(PLAN, "late two", AFTER + 1);
    await run(source, target, rows);
    expect(target.read(rows.keyAt("projects/plan (saved during the move).md")!)).toBe("late one");
    expect(target.read(rows.keyAt("projects/plan (saved during the move 2).md")!)).toBe("late two");
    expect(target.read(PLAN)).toBe("new side");
  });

  test("a file too large to move is counted and left in the old bucket", async () => {
    const source = bucket({ "big.bin": ["x".repeat(64), AFTER, "application/octet-stream"] });
    const target = bucket();
    const page = await source.store.list({});
    await expect(
      catchUpPage({
        source: source.store,
        target: target.store,
        rows: tree().api,
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
        rows: tree().api,
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
      catchUpObject({ source: source.store, target: target.store, rows: tree().api, key: PLAN, byteCap: CAP }),
    ).resolves.toBe("gone");
  });
});
