/**
 * Every workspace on notes by id (`functions/noteIdsAll.ts`): the dry run
 * counts and starts nothing, the run starts each workspace's owed work and the
 * pass's end keys it, and `verify` counts the live notes still not at their id
 * keys from the rows themselves.
 *
 * Sabotage: make `run` start nothing and the second case fails (the workspace
 * stays unkeyed); make `verify` count keyed rows and the last case fails.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { keyedWorkspace } from "../../functions/lib/noteIds/keyedState";
import { copyRowOf } from "../../functions/lib/noteIds/state";
import { boundWorkspace, bucket, chain, drain, observeKeys, rowAt, tester, user, type T } from "./noteIds.helpers";

async function setLayout(t: T, mode: "paths" | "ids" | "keys", paused = false): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("noteIdLayout", { paused, mode, updatedAt: 1 });
  });
}

async function readyTree(t: T, ws: Id<"workspaces">): Promise<void> {
  await t.run(async (ctx) => {
    const row = (await ctx.db.query("nodeTrees").collect()).find((tree) => tree.workspaceId === ws) ?? null;
    if (row === null) await ctx.db.insert("nodeTrees", { workspaceId: ws, status: "ready", dirty: false, files: 0 });
    else await ctx.db.patch(row._id, { status: "ready" });
  });
}

/** An unkeyed workspace: one note in its bucket at its path, its tree ready, no copy row. */
async function unkeyedWorkspace(t: T, slug: string) {
  const ws = await boundWorkspace(t, slug);
  const store = bucket({ "inbox/welcome.md": "# Welcome\n" });
  await observeKeys(t, ws, store, ["inbox/welcome.md"]);
  await readyTree(t, ws);
  return { ws, store };
}

async function runAll(t: T, dryRun: boolean) {
  const pages = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await t.mutation(internal.functions.noteIdsAll.run, { dryRun, ...(cursor === undefined ? {} : { cursor }) });
    pages.push(page);
    if (page.done) break;
    cursor = page.cursor;
  }
  return pages;
}

async function verifyAll(t: T) {
  const total = { liveNotes: 0, unkeyed: 0, unkeyedInKeyed: 0 };
  let cursor: string | undefined;
  for (;;) {
    const page = await t.query(internal.functions.noteIdsAll.verify, cursor === undefined ? {} : { cursor });
    total.liveNotes += page.liveNotes;
    total.unkeyed += page.unkeyed;
    total.unkeyedInKeyed += page.unkeyedInKeyed;
    if (page.done) return total;
    cursor = page.cursor;
  }
}

describe("every workspace on notes by id", () => {
  test("a dry run counts each workspace's stage and starts nothing", async () => {
    const t = tester();
    await setLayout(t, "keys");
    const { ws } = await unkeyedWorkspace(t, "pending");
    const owner = await user(t, "loose@example.test");
    await t.run((ctx) =>
      ctx.db.insert("workspaces", { slug: "nostorage", displayName: "No storage", createdBy: owner, kind: "personal", structureTemplate: "para", createdAt: 1, updatedAt: 1 }),
    );
    const [page] = await runAll(t, true);
    expect(page!.stages).toMatchObject({ not_started: 1, no_storage: 1, keyed: 0 });
    expect(page!.started).toBe(0);
    expect(await t.run((ctx) => copyRowOf(ctx.db, ws))).toBeNull();
  });

  test("a tree that is not ready says why: its status, its error label, whether it has rows, archived or not", async () => {
    const t = tester();
    await setLayout(t, "keys");
    await boundWorkspace(t, "no-tree");
    const { ws } = await unkeyedWorkspace(t, "stuck");
    await t.run(async (ctx) => {
      const tree = (await ctx.db.query("nodeTrees").collect()).find((row) => row.workspaceId === ws)!;
      await ctx.db.patch(tree._id, { status: "filling", error: "list_failed" });
    });

    const [page] = await runAll(t, true);

    expect(page!.stages.tree_not_ready).toBe(2);
    expect(page!.notReady).toEqual({ statuses: { none: 1, filling: 1 }, errors: { list_failed: 1 }, withRows: 1, archived: 0 });
  });

  test("the run starts an unkeyed workspace's pass, and the pass's end keys it", async () => {
    const t = tester();
    await setLayout(t, "keys");
    const { ws, store } = await unkeyedWorkspace(t, "pending");
    const [page] = await runAll(t, false);
    expect(page!.started).toBe(1);

    const row = (await t.run((ctx) => copyRowOf(ctx.db, ws)))!;
    const c = chain(t, ws, store);
    c.pending.push({ name: "functions/noteIdsCopy:run", args: { workspaceId: ws, runId: row.runId } });
    await drain(c);

    expect(await t.run((ctx) => keyedWorkspace(ctx.db, ws))).toBe(true);
    const note = await rowAt(t, ws, "inbox/welcome.md");
    expect(note?.storageKey).toBe(`notes/${note?.noteId}.md`);
    const [after] = await runAll(t, true);
    expect(after!.stages).toMatchObject({ keyed: 1, not_started: 0 });
  });

  test("nothing starts unless the switch is at keys and the copy is running, and the run says why", async () => {
    const t = tester();
    await setLayout(t, "keys", true);
    await unkeyedWorkspace(t, "pending");
    const [page] = await runAll(t, false);
    expect(page).toMatchObject({ started: 0, refused: "paused" });
  });

  test("verify counts live notes not at their id keys, and those in a workspace that says it is keyed", async () => {
    const t = tester();
    await setLayout(t, "keys");
    const { ws } = await unkeyedWorkspace(t, "pending");
    expect(await verifyAll(t)).toEqual({ liveNotes: 1, unkeyed: 1, unkeyedInKeyed: 0 });

    // The workspace claims keyed while its note is still at its path: the one case a deletion would lose.
    await t.run((ctx) =>
      ctx.db.insert("noteIdCopies", { workspaceId: ws, status: "done", runId: 1, files: 1, copied: 1, failed: 0, failures: [], updatedAt: 1, keyedAt: 1 }),
    );
    expect(await verifyAll(t)).toEqual({ liveNotes: 1, unkeyed: 1, unkeyedInKeyed: 1 });

    const note = (await rowAt(t, ws, "inbox/welcome.md"))!;
    await t.run((ctx) => ctx.db.patch(note._id as Id<"nodes">, { storageKey: `notes/${note.noteId}.md` }));
    expect(await verifyAll(t)).toEqual({ liveNotes: 1, unkeyed: 0, unkeyedInKeyed: 0 });
  });
});
