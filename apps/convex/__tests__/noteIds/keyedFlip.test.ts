/**
 * The flip to keyed rows (`lib/noteIds/flip.ts`, `noteIdsCopy.flip`) and the
 * diagnosis of keyed rows (`lib/noteIds/checkPass.ts`), through the real
 * functions with the bucket as the memory store.
 *
 * Sabotage: drop the `keys`-mode gate in `flip` and the ids-mode case fails;
 * drop the tree-ready gate and the filling case fails; drop `copyMatches` from
 * `flipTarget` and the stale case fails; drop `isPlumbing` from `owesKey` and the
 * privacy case fails; drop `storageKey` from `copyIsFresh` and the copy-after-flip
 * case fails; drop the seam repair in `recordKeyedCheckPage` and the diagnosis case fails.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { convexNodeTable } from "../../functions/lib/nodes/convexTable";
import { seedTreeRows } from "../fixtures.helpers";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { FLIP_PAGE } from "../../functions/lib/noteIds/flip";
import { idKeyFor, newNoteId } from "../../functions/lib/nodes/noteIds";
import { beginCopyPass, copyRowOf } from "../../functions/lib/noteIds/state";
import {
  ADMIN,
  boundWorkspace,
  bucket,
  chain,
  drain,
  pass,
  rowAt,
  runPass,
  tester,
  user,
  type Chain,
  type T,
} from "./noteIds.helpers";
import type { Store } from "./noteIds.helpers";

/**
 * Lay the bucket's objects named by `keys` into the tree at their current
 * versions: a row the tree does not hold is written unkeyed, as a path row
 * (`seedTreeRows`); a row it holds takes the object's etag and size, as a
 * path-keyed write of the product leaves it. Nothing lists the bucket.
 */
async function observeKeys(t: T, ws: Id<"workspaces">, store: Store, keys: string[], at = Date.now()): Promise<void> {
  const created: { path: string; etag: string; size: number }[] = [];
  for (const key of keys) {
    const object = await store.get(key);
    if (object === null) continue;
    const size = store.bytesOf(key)?.byteLength ?? 0;
    const row = await rowAt(t, ws, key);
    if (row === null) {
      created.push({ path: key, etag: object.etag, size });
      continue;
    }
    await t.run(async (ctx) => {
      const table = convexNodeTable(ctx as MutationCtx, ws);
      await table.patch(row._id, { etag: object.etag, size, observedAt: at });
      await table.logChange?.(key, false);
    });
  }
  if (created.length > 0) await seedTreeRows(t, ws, created);
}

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  delete process.env.STORAGE_MOVER_ORIGIN;
});
afterEach(() => {
  vi.useRealTimers();
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

const decode = (bytes: Uint8Array | null | undefined) => (bytes == null ? undefined : new TextDecoder().decode(bytes));

/** The switch at `mode`, creating the row when there is none. */
async function setLayout(t: T, mode: "paths" | "ids" | "keys"): Promise<void> {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("noteIdLayout").first();
    if (row === null) await ctx.db.insert("noteIdLayout", { paused: false, mode, updatedAt: 1 });
    else await ctx.db.patch(row._id, { mode, updatedAt: 1 });
  });
}

/** The tree's state for the workspace: `ready` lets the flip run. */
async function setTree(t: T, ws: Id<"workspaces">, status: "ready" | "filling"): Promise<void> {
  await t.run(async (ctx) => {
    const row = (await ctx.db.query("nodeTrees").collect()).find((tree) => tree.workspaceId === ws) ?? null;
    if (row === null) await ctx.db.insert("nodeTrees", { workspaceId: ws, status, dirty: false, files: 0 });
    else await ctx.db.patch(row._id, { status });
  });
}

/** Schedules one flip page and runs the chain until nothing is scheduled. Returns how many pages ran. */
async function flipNow(c: Chain): Promise<number> {
  c.pending.push({ name: "functions/noteIdsCopy:flip", args: { workspaceId: c.workspaceId } });
  return await drain(c);
}

/** Keys mode with a ready tree, the state the flip needs. */
async function keysReady(t: T, ws: Id<"workspaces">): Promise<void> {
  await setTree(t, ws, "ready");
  await setLayout(t, "keys");
}

async function copyRow(t: T, ws: Id<"workspaces">) {
  return await t.run((ctx) => copyRowOf(ctx.db, ws));
}

/** A live file row that already holds a fresh copy, written straight into the tree (no bucket). */
async function insertCopied(t: T, ws: Id<"workspaces">, path: string, etag: string, extra: { parsed?: string } = {}): Promise<string> {
  return await t.run(async (ctx) => {
    const noteId = newNoteId();
    return await ctx.db.insert("nodes", {
      workspaceId: ws,
      path,
      name: path.split("/").pop() as string,
      kind: "file",
      etag,
      observedAt: Date.now(),
      noteId,
      idCopy: { key: idKeyFor(noteId, path), etag, copiedAt: Date.now(), keyEtag: `key-${etag}` },
      ...(extra.parsed === undefined ? {} : { parsed: extra.parsed }),
    });
  });
}

describe("the flip: which rows are keyed, and when", () => {
  test("a fresh copy is keyed, a stale one is left for the next pass, and keyedAt is set", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "flipfresh");
    const store = bucket({ "1-projects/a.md": "# A\n", "1-projects/b.md": "# B\n" });
    await observeKeys(t, ws, store, ["1-projects/a.md", "1-projects/b.md"]);
    const c = chain(t, ws, store);
    await runPass(c);

    // b is edited after its copy: its copy is no longer true.
    store.seed("1-projects/b.md", "# B, edited\n");
    await observeKeys(t, ws, store, ["1-projects/a.md", "1-projects/b.md"], Date.now() + 1_000);
    await keysReady(t, ws);
    await flipNow(c);

    const a = await rowAt(t, ws, "1-projects/a.md");
    const b = await rowAt(t, ws, "1-projects/b.md");
    expect(a).toMatchObject({ storageKey: `notes/${a?.noteId}.md`, etag: a?.idCopy?.keyEtag });
    expect(b?.storageKey).toBeUndefined();
    expect(await copyRow(t, ws)).toMatchObject({ keyedAt: expect.any(Number) });
    expect((await copyRow(t, ws))?.keyedDoneAt).toBeUndefined();
  });

  test("the keyed row keeps the path etag it had in keyedFrom, and takes the key's etag as its own", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "flipversions");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeKeys(t, ws, store, ["1-projects/a.md"]);
    const c = chain(t, ws, store);
    await runPass(c);
    const before = await rowAt(t, ws, "1-projects/a.md");
    await keysReady(t, ws);
    await flipNow(c);

    const after = await rowAt(t, ws, "1-projects/a.md");
    expect(after?.keyedFrom).toEqual({ pathEtag: before?.etag, keyEtag: before?.idCopy?.keyEtag });
    expect(after?.etag).toBe(before?.idCopy?.keyEtag);
    expect(after?.size).toBe(before?.size);
  });

  test("a flip writes no change-log entry: the bytes did not change", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "flipquiet");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeKeys(t, ws, store, ["1-projects/a.md"]);
    const c = chain(t, ws, store);
    await runPass(c);
    const logBefore = await t.run((ctx) => ctx.db.query("nodeLog").collect().then((rows) => rows.length));
    await keysReady(t, ws);
    await flipNow(c);
    const logAfter = await t.run((ctx) => ctx.db.query("nodeLog").collect().then((rows) => rows.length));
    expect(logAfter).toBe(logBefore);
  });

  test("a parsed read of the path version is rebased to the key's; another version is left alone", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "flipparsed");
    const same = await insertCopied(t, ws, "1-projects/same.md", "e-same", { parsed: "e-same" });
    const other = await insertCopied(t, ws, "1-projects/other.md", "e-other", { parsed: "e-older" });
    await keysReady(t, ws);
    const c = chain(t, ws, bucket({}));
    await flipNow(c);

    expect(await t.run((ctx) => ctx.db.get(same as never))).toMatchObject({ storageKey: expect.any(String), parsed: "key-e-same" });
    expect(await t.run((ctx) => ctx.db.get(other as never))).toMatchObject({ storageKey: expect.any(String), parsed: "e-older" });
  });

  test("a row whose copy was recorded under another key is not keyed, and nothing is keyed in its place", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "flipmismatch");
    const wrong = await insertCopied(t, ws, "1-projects/wrong.md", "e-w");
    await t.run((ctx) => ctx.db.patch(wrong as never, { idCopy: { key: "notes/0190c0de-0000-7000-8000-00000000dead.md", etag: "e-w", copiedAt: 1, keyEtag: "k" } }));
    await keysReady(t, ws);
    const c = chain(t, ws, bucket({}));
    await flipNow(c);

    const row = await t.run((ctx) => ctx.db.get(wrong as never));
    expect(row?.storageKey).toBeUndefined();
    expect(row?.etag).toBe("e-w");
    // Not keyed means the walk did not finish: the pass that follows owes it a copy.
    expect((await copyRow(t, ws))?.keyedDoneAt).toBeUndefined();
  });

  test("privacy.md is never keyed, and does not hold the flip back from finishing", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "flipprivacy");
    const privacy = await insertCopied(t, ws, "privacy.md", "e-priv");
    await insertCopied(t, ws, "1-projects/note.md", "e-note");
    await keysReady(t, ws);
    const c = chain(t, ws, bucket({}));
    await flipNow(c);

    const plumbing = await t.run((ctx) => ctx.db.get(privacy as never));
    expect(plumbing?.storageKey).toBeUndefined();
    expect(plumbing?.etag).toBe("e-priv");
    expect(await rowAt(t, ws, "1-projects/note.md")).toMatchObject({ storageKey: expect.any(String) });
    expect((await copyRow(t, ws))?.keyedDoneAt).toEqual(expect.any(Number));
  });

  test("no flip while the tree is still filling, and the flip runs once it is ready", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "flipfilling");
    const store = bucket({ "1-projects/a.md": "# A\n" });
    await observeKeys(t, ws, store, ["1-projects/a.md"]);
    const c = chain(t, ws, store);
    await setTree(t, ws, "filling");
    await setLayout(t, "keys");
    await runPass(c);
    expect((await rowAt(t, ws, "1-projects/a.md"))?.storageKey).toBeUndefined();
    expect((await copyRow(t, ws))?.keyedAt).toBeUndefined();

    await setTree(t, ws, "ready");
    await flipNow(c);
    expect((await rowAt(t, ws, "1-projects/a.md"))?.storageKey).toBeDefined();
  });

  test("keyedAt is set once: a later page does not move it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = tester();
    const ws = await boundWorkspace(t, "flipsetonce");
    const store = bucket({ "1-projects/a.md": "# A\n", "1-projects/b.md": "# B\n" });
    await observeKeys(t, ws, store, ["1-projects/a.md", "1-projects/b.md"]);
    const c = chain(t, ws, store);
    await runPass(c);
    store.seed("1-projects/b.md", "# B, edited\n");
    await observeKeys(t, ws, store, ["1-projects/a.md", "1-projects/b.md"], Date.now() + 1_000);
    await keysReady(t, ws);

    vi.setSystemTime(1_000);
    await flipNow(c);
    const first = (await copyRow(t, ws))?.keyedAt;
    vi.setSystemTime(5_000);
    await flipNow(c);
    expect(first).toBe(1_000);
    expect((await copyRow(t, ws))?.keyedAt).toBe(1_000);
  });

  test("keyedDoneAt is set once no live note is left unkeyed", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "flipdone");
    const store = bucket({ "1-projects/a.md": "# A\n", "1-projects/b.md": "# B\n" });
    await observeKeys(t, ws, store, ["1-projects/a.md", "1-projects/b.md"]);
    const c = chain(t, ws, store);
    await runPass(c);
    await keysReady(t, ws);
    await flipNow(c);

    const row = await copyRow(t, ws);
    expect(row?.keyedDoneAt).toEqual(expect.any(Number));
    expect(await rowAt(t, ws, "1-projects/a.md")).toMatchObject({ storageKey: expect.any(String) });
    expect(await rowAt(t, ws, "1-projects/b.md")).toMatchObject({ storageKey: expect.any(String) });
  });

  test("once keyedDoneAt is set the flip does nothing more", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "flipfinished");
    await insertCopied(t, ws, "1-projects/a.md", "e-a");
    await keysReady(t, ws);
    const c = chain(t, ws, bucket({}));
    await flipNow(c);
    const finished = await copyRow(t, ws);
    await insertCopied(t, ws, "1-projects/later.md", "e-l");
    await flipNow(c);
    expect((await rowAt(t, ws, "1-projects/later.md"))?.storageKey).toBeUndefined();
    expect((await copyRow(t, ws))?.keyedDoneAt).toBe(finished?.keyedDoneAt);
  });

  test("a walk over more than one page keys every row: one page cannot key more than FLIP_PAGE", async () => {
    vi.useFakeTimers();
    const t = tester();
    const ws = await boundWorkspace(t, "flippaging");
    const total = FLIP_PAGE * 2 + 50;
    for (let index = 0; index < total; index += 1) {
      await insertCopied(t, ws, `1-projects/p${String(index).padStart(4, "0")}.md`, `e${index}`);
    }
    await keysReady(t, ws);
    // The flip schedules its own next pages through convex-test's scheduler, so run those until none is left.
    await t.mutation(internal.functions.noteIdsCopy.flip, { workspaceId: ws });
    const afterFirstPage = await t.run((ctx) => ctx.db.query("nodes").collect().then((rows) => rows.filter((row) => row.storageKey !== undefined).length));
    expect(afterFirstPage).toBe(FLIP_PAGE);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const keyed = await t.run((ctx) => ctx.db.query("nodes").collect().then((rows) => rows.filter((row) => row.storageKey !== undefined).length));
    expect(keyed).toBe(total);
    expect((await copyRow(t, ws))?.keyedDoneAt).toEqual(expect.any(Number));
  });

  test("a row the first page leaves unkeyed keeps the walk from finishing on a later page", async () => {
    vi.useFakeTimers();
    const t = tester();
    const ws = await boundWorkspace(t, "flipcarry");
    // The stale row sorts first, so page one passes it and page two, which has nothing stale, must still not finish.
    const stale = await insertCopied(t, ws, "1-projects/aa-stale.md", "e-stale");
    await t.run((ctx) => ctx.db.patch(stale as never, { etag: "moved-on" }));
    for (let index = 0; index < FLIP_PAGE + 5; index += 1) {
      await insertCopied(t, ws, `1-projects/p${String(index).padStart(4, "0")}.md`, `e${index}`);
    }
    await keysReady(t, ws);
    await t.mutation(internal.functions.noteIdsCopy.flip, { workspaceId: ws });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await rowAt(t, ws, "1-projects/p0204.md"))?.storageKey).toBeDefined();
    expect((await rowAt(t, ws, "1-projects/aa-stale.md"))?.storageKey).toBeUndefined();
    expect((await copyRow(t, ws))?.keyedDoneAt).toBeUndefined();
  });

});

describe("keyed rows through the copy pass and the diagnosis", () => {
  async function keyedWorkspace(t: T, slug: string, files: Record<string, string>) {
    const ws = await boundWorkspace(t, slug);
    const store: Store = bucket(files);
    const paths = Object.keys(files);
    await observeKeys(t, ws, store, paths);
    const c = chain(t, ws, store);
    await runPass(c);
    await keysReady(t, ws);
    await flipNow(c);
    return { ws, store, c, paths };
  }

  test("a copy pass after the flip never copies a keyed row's path over its key", async () => {
    const t = tester();
    const { ws, store, c } = await keyedWorkspace(t, "copyafterflip", { "1-projects/a.md": "# A\n" });
    const a = await rowAt(t, ws, "1-projects/a.md");
    const key = a!.storageKey!;
    expect(decode(store.bytesOf(key))).toBe("# A\n");
    const keyEtag = (await store.get(key))?.etag;

    // The frozen path object diverges from the key, as it would after a flip.
    store.seed("1-projects/a.md", "# frozen path copy\n");
    // The scan offers no keyed row to copy: its path is not what the copy pass may write.
    const offered = await t.query(internal.functions.noteIdsCopy.copyPage, { workspaceId: ws, limit: 200 });
    expect(offered.items).toEqual([]);
    expect(offered.fresh).toBe(1);
    await runPass(c);

    expect(decode(store.bytesOf(key))).toBe("# A\n");
    expect((await store.get(key))?.etag).toBe(keyEtag);
    expect(await rowAt(t, ws, "1-projects/a.md")).toMatchObject({ storageKey: key });
  });

  test("the diagnosis takes a key's newer version onto a keyed row, and reports a missing key without copying it", async () => {
    const t = tester();
    const { ws, store, c } = await keyedWorkspace(t, "diagnosekeyed", { "1-projects/a.md": "# A\n", "1-projects/b.md": "# B\n" });
    const a = await rowAt(t, ws, "1-projects/a.md");
    const b = await rowAt(t, ws, "1-projects/b.md");
    // a's report was lost: the row still holds an older etag than its key.
    await t.run((ctx) => ctx.db.patch(a!._id, { etag: "lost-report" }));
    // b's key is gone from the bucket.
    store.objects.delete(b!.storageKey!);
    const keyAEtag = (await store.get(a!.storageKey!))?.etag;
    const pathBBytes = decode(store.bytesOf("1-projects/b.md"));

    c.pending.push({
      name: "functions/noteIdsCopy:runCheck",
      args: { workspaceId: ws, runId: 0, checkedAt: Date.now(), checked: 0, missing: 0, differs: 0 },
    });
    await drain(c);

    expect(await rowAt(t, ws, "1-projects/a.md")).toMatchObject({ etag: keyAEtag, storageKey: a!.storageKey });
    expect(await rowAt(t, ws, "1-projects/b.md")).toMatchObject({ etag: b!.etag, storageKey: b!.storageKey });
    expect(store.bytesOf(b!.storageKey!)).toBeNull();
    expect(decode(store.bytesOf("1-projects/b.md"))).toBe(pathBBytes);
    expect((await pass(c))?.diagnosis).toMatchObject({ checked: 2, missing: 1, differs: 1 });
  });

  test("a copy result for a keyed row marks nothing on it: its copy record is as the flip left it", async () => {
    const t = tester();
    const { ws, c } = await keyedWorkspace(t, "recordkeyed", { "1-projects/a.md": "# A\n" });
    const before = await rowAt(t, ws, "1-projects/a.md");
    await t.run((ctx) => beginCopyPass(ctx, ws, { force: true }));
    const runId = (await copyRow(t, ws))!.runId;
    await t.mutation(internal.functions.noteIdsCopy.recordCopy, {
      workspaceId: ws,
      runId,
      done: true,
      found: false,
      files: 1,
      fresh: 0,
      refused: [],
      results: [{ path: "1-projects/a.md", ok: true, etag: before!.etag!, keyEtag: "anything" }],
    });
    expect((await rowAt(t, ws, "1-projects/a.md"))?.idCopy).toEqual(before?.idCopy);
    expect(c.pending).toEqual([]);
  });

  test("the diagnosis leaves a keyed row alone when its key is as the row says", async () => {
    const t = tester();
    const { ws, c } = await keyedWorkspace(t, "diagnosesame", { "1-projects/a.md": "# A\n" });
    const before = await rowAt(t, ws, "1-projects/a.md");
    c.pending.push({
      name: "functions/noteIdsCopy:runCheck",
      args: { workspaceId: ws, runId: 0, checkedAt: Date.now(), checked: 0, missing: 0, differs: 0 },
    });
    await drain(c);
    expect(await rowAt(t, ws, "1-projects/a.md")).toEqual(before);
    expect((await pass(c))?.diagnosis).toMatchObject({ checked: 1, missing: 0, differs: 0 });
  });

  test("the diagnosis rejects a keyed row whose key the row no longer names", async () => {
    const t = tester();
    const { ws, c } = await keyedWorkspace(t, "diagnosemoved", { "1-projects/a.md": "# A\n" });
    const a = await rowAt(t, ws, "1-projects/a.md");
    // The row moved to another key between the read and the record: nothing it says is counted.
    await t.run((ctx) => ctx.db.patch(a!._id, { storageKey: "notes/0190c0de-0000-7000-8000-00000000beef.md" }));
    const counted = await t.mutation(internal.functions.noteIdsCopy.recordKeyedCheck, {
      workspaceId: ws,
      answers: [{ path: "1-projects/a.md", key: a!.storageKey!, etag: a!.etag!, headEtag: "other" }],
    });
    expect(counted).toEqual({ checked: 0, missing: 0, differs: 0 });
    expect(c.pending).toEqual([]);
  });
});
