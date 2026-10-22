/**
 * A workspace made after the switch left `paths` (`noteIds.keepCurrent`):
 * `startAll` and the switch to `keys` reached only the workspaces that existed
 * then, so the cron starts each later one's first pass, and that pass's end
 * flips it to keyed. Through the real functions with the bucket as the memory store.
 *
 * Sabotage: drop the `row === null` branch from `keepCurrent` and the
 * new-workspace case fails (the workspace stays on path keys, which the
 * console shows as "Differs"); drop its `treeReady` gate and the filling case
 * fails; drop the flip-again branch and the late-tree case fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { keyedWorkspace } from "../../functions/lib/noteIds/keyedState";
import { copyRowOf } from "../../functions/lib/noteIds/state";
import { FIRST_COPIES_PER_TICK } from "../../functions/noteIds";
import { ADMIN, boundWorkspace, bucket, chain, drain, observeKeys, rowAt, runPass, tester, type T } from "./noteIds.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  delete process.env.STORAGE_MOVER_ORIGIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

async function setLayout(t: T, mode: "paths" | "ids" | "keys"): Promise<void> {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("noteIdLayout").first();
    if (row === null) await ctx.db.insert("noteIdLayout", { paused: false, mode, updatedAt: 1 });
    else await ctx.db.patch(row._id, { mode, updatedAt: 1 });
  });
}

async function setTree(t: T, ws: Id<"workspaces">, status: "ready" | "filling"): Promise<void> {
  await t.run(async (ctx) => {
    const row = (await ctx.db.query("nodeTrees").collect()).find((tree) => tree.workspaceId === ws) ?? null;
    if (row === null) await ctx.db.insert("nodeTrees", { workspaceId: ws, status, dirty: false, files: 0 });
    else await ctx.db.patch(row._id, { status });
  });
}

const copyRow = (t: T, ws: Id<"workspaces">) => t.run((ctx) => copyRowOf(ctx.db, ws));
const keyed = (t: T, ws: Id<"workspaces">) => t.run((ctx) => keyedWorkspace(ctx.db, ws));

/** A workspace bound after the switch: one note in its bucket, its tree observed, no copy row. */
async function newWorkspace(t: T, slug: string, tree: "ready" | "filling" = "ready") {
  const ws = await boundWorkspace(t, slug);
  const store = bucket({ "0-inbox/welcome.md": "# Welcome\n" });
  await observeKeys(t, ws, store, ["0-inbox/welcome.md"]);
  await setTree(t, ws, tree);
  return { ws, store };
}

describe("a workspace made after the switch", () => {
  test("in keys mode, the cron starts its first pass, and the pass's end keys it", async () => {
    const t = tester();
    await setLayout(t, "keys");
    const { ws, store } = await newWorkspace(t, "newcomer");
    expect(await copyRow(t, ws)).toBeNull();

    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 1 });
    const row = (await copyRow(t, ws))!;
    expect(row.status).toBe("copying");

    // Run the pass the cron scheduled; its end schedules the flip.
    const c = chain(t, ws, store);
    c.pending.push({ name: "functions/noteIdsCopy:run", args: { workspaceId: ws, runId: row.runId } });
    await drain(c);

    const note = await rowAt(t, ws, "0-inbox/welcome.md");
    expect(note?.storageKey).toBe(`notes/${note?.noteId}.md`);
    expect(await keyed(t, ws)).toBe(true);
    expect(await copyRow(t, ws)).toMatchObject({ status: "done", keyedAt: expect.any(Number), keyedDoneAt: expect.any(Number) });

    // Keyed and finished: after the one diagnosis every keyed workspace gets (`keyedRecheck.ts`), nothing more starts for it.
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 1 });
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 0 });
  });

  test("in ids mode, the cron copies it too, so the switch to keys is not held back by it", async () => {
    const t = tester();
    await setLayout(t, "ids");
    const { ws } = await newWorkspace(t, "idsnewcomer");
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 1 });
    expect((await copyRow(t, ws))?.status).toBe("copying");
  });

  test("in paths mode, nothing starts: the copy has not been switched on", async () => {
    const t = tester();
    const { ws } = await newWorkspace(t, "pathsnewcomer");
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 0 });
    await setLayout(t, "paths");
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 0 });
    expect(await copyRow(t, ws)).toBeNull();
  });

  test("nothing starts while its tree is still filling, and the pass starts once it is ready", async () => {
    const t = tester();
    await setLayout(t, "keys");
    const { ws } = await newWorkspace(t, "fillingnewcomer", "filling");
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 0 });
    expect(await copyRow(t, ws)).toBeNull();

    await setTree(t, ws, "ready");
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 1 });
  });

  test("an idle copy row, made by something that only asked for it, is started the same way", async () => {
    const t = tester();
    await setLayout(t, "keys");
    const { ws } = await newWorkspace(t, "idlenewcomer");
    await t.run((ctx) => ctx.db.insert("noteIdCopies", { workspaceId: ws, status: "idle", runId: 0, files: 0, copied: 0, failed: 0, failures: [], updatedAt: 1 }));
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 1 });
    expect((await copyRow(t, ws))?.status).toBe("copying");
  });

  test("a pass that finished before its tree was ready is flipped once the tree is", async () => {
    const t = tester();
    await setLayout(t, "keys");
    const { ws, store } = await newWorkspace(t, "latetree", "filling");
    const c = chain(t, ws, store);
    await runPass(c);
    expect(await copyRow(t, ws)).toMatchObject({ status: "done" });
    expect(await keyed(t, ws)).toBe(false);

    // Nothing changed, so no pass is owed: still filling, nothing to do.
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 0 });
    await setTree(t, ws, "ready");
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: 1 });
    c.pending.push({ name: "functions/noteIdsCopy:flip", args: { workspaceId: ws } });
    await drain(c);
    expect(await keyed(t, ws)).toBe(true);
  });

  test(`no more than ${FIRST_COPIES_PER_TICK} first passes start in one tick`, async () => {
    const t = tester();
    await setLayout(t, "keys");
    for (let i = 0; i <= FIRST_COPIES_PER_TICK; i += 1) {
      const ws = await boundWorkspace(t, `many${i}`);
      await setTree(t, ws, "ready");
    }
    const copying = () => t.run(async (ctx) => (await ctx.db.query("noteIdCopies").collect()).filter((row) => row.status === "copying").length);
    expect(await t.mutation(internal.functions.noteIds.keepCurrent, {})).toEqual({ started: FIRST_COPIES_PER_TICK });
    expect(await copying()).toBe(FIRST_COPIES_PER_TICK);
    // The next tick starts the one left (and picks up the passes whose pages have not run here).
    await t.mutation(internal.functions.noteIds.keepCurrent, {});
    expect(await copying()).toBe(FIRST_COPIES_PER_TICK + 1);
  });
});
