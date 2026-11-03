/**
 * The control plane's tree reads come from the workspace's object once its notes live there
 * (`lib/nodes/objectTreeStore.ts`): `servedNodesStore`, the store behind the console's file list, walk, paths, map,
 * folder notes, chaos score and folder icons and behind the gateway's manifest and facts, pages the object's rows
 * and judges them by the rules the object holds, through the gateway's real door into a real object on node:sqlite.
 *
 * Parity first: after a real push, the object's store answers exactly what Convex's rows answer, for an owner and for
 * a team member kept out of a private folder. Then: Convex's rows answer only while the object cannot be the whole
 * answer (not on its object, a change still waiting in the outbox, the object behind), and a walk that finds the
 * object behind part way fails rather than mixing the two.
 *
 * Sabotage, each confirmed to fail a case here: drop the object branch from `servedNodesStore` (the object-only rows
 * never show), drop the `waitingSince` check (a share taken back is served from the object's older rules), drop the
 * `behind` check on the first page (the object's pre-narrowing rules are used), ignore `root` in `filesPage`.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { canSee } from "../functions/lib/privacy";
import { loadPrivacyState } from "../functions/lib/fileOps";
import { NO_BUCKET, servedKeys, servedNodesStore } from "../functions/lib/nodes/manifestStore";
import { ObjectTreeBehind } from "../functions/lib/nodes/objectTreeStore";
import type { TestConvex } from "./fixtures.helpers";
import { asUser, drainScheduled, seedStorageBinding, seedTreeRows } from "./fixtures.helpers";
import { drain, setFolder, setHome, world } from "./workspaceObjectWorld.helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** An action's context over the test deployment: what `servedNodesStore` runs its queries and the door's ticket through. */
function actionCtx(t: TestConvex): ActionCtx {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runQuery: (ref: any, args: any) => t.query(ref, args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runMutation: (ref: any, args: any) => t.mutation(ref, args),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runAction: (ref: any, args: any) => t.action(ref, args),
  } as unknown as ActionCtx;
}

/** What a reader at `scope` is shown by a served store: its keys, each judged by the store's own rules. */
async function shown(store: Awaited<ReturnType<typeof servedNodesStore>>, scope: "private" | "team") {
  if (store === null) return null;
  const privacy = await loadPrivacyState(store);
  return (await servedKeys(store)).filter((key) => canSee(key, scope, privacy.rules, privacy.overrides));
}

const PATHS = ["plans/a.md", "plans/b.md", "secret/rates.md", "todo.md", "zeta/deep/one.md"];

/** A workspace on its object, its rows and rules pushed through the real door, with `secret/` private. */
async function pushedWorld() {
  const w = await world();
  const { t, owner, workspaceId, stores } = w;
  await seedStorageBinding(t, { workspaceId, boundBy: owner, status: "connected" });
  await seedTreeRows(t, workspaceId, PATHS);
  await setFolder(t, workspaceId, owner, "plans", "team");
  await setFolder(t, workspaceId, owner, "secret", "private");
  await setHome(t, workspaceId, "object");
  await t.run(async (ctx) => {
    const ids = (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect()).map((row) => row._id);
    await ctx.db.insert("workspaceObjectOutbox", { workspaceId, nodeIds: ids, access: true, at: Date.now() });
  });
  await drain(t, workspaceId);
  stores.get(`workspace:${workspaceId}`)!.rows.setHome("object");
  return w;
}

/** Convex's own answer, as before this change: the store read with the workspace off its object for the moment. */
async function convexAnswer(t: TestConvex, workspaceId: Id<"workspaces">, scope: "private" | "team") {
  await setHome(t, workspaceId, "bucket");
  try {
    return await shown(await servedNodesStore(actionCtx(t), workspaceId, NO_BUCKET), scope);
  } finally {
    await setHome(t, workspaceId, "object");
  }
}

describe("the control plane's tree reads come from the workspace object", () => {
  test("parity: after a push, the object's store shows each reader exactly what Convex's rows show", async () => {
    const { t, workspaceId, ops } = await pushedWorld();
    for (const scope of ["private", "team"] as const) {
      const before = ops().length;
      const fromObject = await shown(await servedNodesStore(actionCtx(t), workspaceId, NO_BUCKET), scope);
      expect(ops().slice(before)).toContain("ws.rows.files");
      expect(fromObject).toEqual(await convexAnswer(t, workspaceId, scope));
    }
    expect(await shown(await servedNodesStore(actionCtx(t), workspaceId, NO_BUCKET), "team")).not.toContain("secret/rates.md");
    expect(await shown(await servedNodesStore(actionCtx(t), workspaceId, NO_BUCKET), "private")).toContain("secret/rates.md");
  });

  test("an object-home read is the object's rows: a row only the object holds shows, and Convex's are not consulted", async () => {
    const { t, workspaceId, stores } = await pushedWorld();
    const held = stores.get(`workspace:${workspaceId}`)!;
    held.rows.put([{ id: "only-in-object", path: "plans/c.md", kind: "file", etag: "c", at: Date.now() + 1000 }]);
    // Convex's tree is no longer served: an answer can only have come from the object.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("nodeTrees").collect()) await ctx.db.delete(row._id);
    });
    const keys = await shown(await servedNodesStore(actionCtx(t), workspaceId, NO_BUCKET), "team");
    expect(keys).toContain("plans/c.md");
  });

  test("a workspace still on the bucket never asks its object", async () => {
    const { t, owner, workspaceId, ops } = await world();
    await seedTreeRows(t, workspaceId, PATHS);
    await setFolder(t, workspaceId, owner, "secret", "private");
    const keys = await shown(await servedNodesStore(actionCtx(t), workspaceId, NO_BUCKET), "private");
    expect(keys).toEqual(expect.arrayContaining(PATHS));
    expect(ops()).not.toContain("ws.rows.files");
  });

  test("a share taken back and not yet pushed is answered from Convex, never from the object's older rules", async () => {
    const { t, owner, workspaceId, ops } = await pushedWorld();
    // The object stays reachable; only the push has not run yet (its scheduled drain waits below).
    expect(
      await asUser(t, owner).mutation(api.functions.nodesAccess.setGrantees, { workspaceId, path: "plans", grantees: [], base: "private" }),
    ).toMatchObject({ ok: true });
    const before = ops().length;
    const keys = await shown(await servedNodesStore(actionCtx(t), workspaceId, NO_BUCKET), "team");
    expect(keys).not.toContain("plans/a.md");
    expect(ops().slice(before)).not.toContain("ws.rows.files");
    await drainScheduled(t);
    await drain(t, workspaceId);
    const after = ops().length;
    expect(await shown(await servedNodesStore(actionCtx(t), workspaceId, NO_BUCKET), "team")).not.toContain("plans/a.md");
    expect(ops().slice(after)).toContain("ws.rows.files");
  });

  test("an object with a mark open is not read: Convex's rows answer", async () => {
    const { t, workspaceId, stores } = await pushedWorld();
    const held = stores.get(`workspace:${workspaceId}`)!;
    held.marks.open("a-narrowing-in-flight", 60_000);
    held.rows.put([{ id: "only-in-object", path: "plans/c.md", kind: "file", etag: "c", at: Date.now() + 1000 }]);
    // The object waits its two seconds for the mark, then says behind.
    const keys = await shown(await servedNodesStore(actionCtx(t), workspaceId, NO_BUCKET), "team");
    expect(keys).not.toContain("plans/c.md");
    expect(keys).toContain("plans/a.md");
  });

  test("a walk that finds the object behind part way fails rather than mixing the object's rows with Convex's", async () => {
    const { t, workspaceId, stores, onCall } = await pushedWorld();
    const store = await servedNodesStore(actionCtx(t), workspaceId, NO_BUCKET);
    expect(store).not.toBeNull();
    const held = stores.get(`workspace:${workspaceId}`)!;
    onCall(async (op) => {
      if (op === "ws.rows.files") held.marks.open("late-mark", 60_000);
    });
    await expect(servedKeys(store!)).rejects.toBeInstanceOf(ObjectTreeBehind);
  });
});

describe("the object's file pages", () => {
  test("page in path order, beneath a root, after a cursor, files only and never gone rows", async () => {
    const { workspaceId, stores } = await pushedWorld();
    const rows = stores.get(`workspace:${workspaceId}`)!.rows;
    rows.put([{ id: "gone-one", path: "plans/gone.md", kind: "file", at: Date.now() + 1000 }]);
    rows.remove(["gone-one"], Date.now() + 2000);
    const all = [];
    let after: string | null = null;
    for (;;) {
      const page: { rows: { path: string }[]; cursor: string | null } = rows.filesPage({ after, limit: 2 });
      all.push(...page.rows.map((row) => row.path));
      if (page.cursor === null) break;
      after = page.cursor;
    }
    expect(all).toEqual([...PATHS].sort());
    expect(rows.filesPage({ root: "plans" }).rows.map((row: { path: string }) => row.path)).toEqual(["plans/a.md", "plans/b.md"]);
    expect(rows.filesPage({ root: "zeta" }).rows.map((row: { path: string }) => row.path)).toEqual(["zeta/deep/one.md"]);
    expect(rows.filesPage({ root: "plans", after: "plans/a.md" }).rows.map((row: { path: string }) => row.path)).toEqual(["plans/b.md"]);
  });

  test("an object whose notes do not live there yet answers not served", async () => {
    const { t, workspaceId, stores } = await pushedWorld();
    stores.get(`workspace:${workspaceId}`)!.rows.setHome("dual");
    // The control plane still says object, so only the object's own answer can send this to Convex.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("nodeTrees").collect()) await ctx.db.delete(row._id);
    });
    expect(await servedNodesStore(actionCtx(t), workspaceId, NO_BUCKET)).toBeNull();
  });
});

void internal;
