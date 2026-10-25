/**
 * The built-in `accounts` grantee, the share dialog's All Context users (`lib/nodes/rowAccess.ts`;
 * `docs/decisions/privacy-and-sharing/all-context-users.md`). It is the one exception to "`team` never means public",
 * so it is honoured in the pinned workspace and nowhere else:
 *
 *  - outside it, every write that names it is refused (`setGrantees`, the console's `accounts` tier, `setAccessRow`),
 *    and a grant that got into the table anyway grants nothing on read (`withAccountsHonoured`);
 *  - inside it, it is view only, and the console's tiers write the dialog's four positions.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - let `wantedOf` resolve `accounts` in any workspace (`setAccess.ts`): "refused outside the pinned workspace"
 *    fails three ways;
 *  - make `withAccountsHonoured` return the rows as they are: "a grant written straight into the table" fails;
 *  - drop the role check in `wantedOf`: "view only" fails;
 *  - make `positionOf` write plain `team` for Members before the switch (`nodesAccess.ts`): "Members before the
 *    migration" fails, the note then readable by every account through the pin.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { accessRowsOf } from "../../functions/lib/nodes/accessRows";
import { refreshSnapshot } from "../../functions/lib/nodes/accessBackfill";
import { setAccessRow } from "../../functions/lib/nodes/setAccess";
import {
  asUser,
  createUser,
  createWorkspace,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { parentRows } from "./treeRows.helpers";
import { nodeAt as treeNodeAt } from "../../functions/lib/nodes/paths";

afterEach(() => {
  vi.unstubAllEnvs();
});

const NOTE = "guides/start.md";

async function world() {
  vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
  const t = setupTest();
  const staff = await createUser(t, "staff@example.invalid");
  await createWorkspace(t, staff, "staff-personal");
  const pinned = await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
  const acme = await createWorkspace(t, staff, "acme", { kind: "shared", displayName: "Acme" });
  await t.run(async (ctx) => {
    await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    for (const workspaceId of [pinned, acme]) {
      for (const path of ["guides", NOTE]) {
        await ctx.db.insert("nodes", {
          workspaceId,
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          kind: path.endsWith(".md") ? "file" : "folder",
          observedAt: 1,
        });
      }
      await parentRows(ctx, workspaceId);
    }
  });
  return { t, staff, pinned, acme };
}
type World = Awaited<ReturnType<typeof world>>;

function save(w: World, workspaceId: Id<"workspaces">, grantees: Array<Record<string, unknown>>) {
  return asUser(w.t, w.staff).mutation(api.functions.nodesAccess.setGrantees, {
    workspaceId,
    path: NOTE,
    grantees: grantees as never,
    base: "team",
  });
}

function tier(w: World, workspaceId: Id<"workspaces">, to: "private" | "team", extra: { accounts?: boolean; members?: boolean } = {}) {
  return w.t.mutation(internal.functions.nodesAccess.consoleAccess, {
    workspaceId,
    actorUserId: w.staff,
    path: NOTE,
    kind: "note",
    tier: to,
    ...extra,
  });
}

async function stateOf(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run(async (ctx) => {
    const row = await treeNodeAt(ctx.db, workspaceId, NOTE);
    const grants = await ctx.db
      .query("nodeAccess")
      .withIndex("by_node", (q) => q.eq("nodeId", row!._id))
      .collect();
    return {
      access: row?.access,
      grants: grants
        .map((grant) => `${grant.granteeKind}:${grant.role}`)
        .sort(),
    };
  });
}

async function flipSwitch(t: TestConvex) {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("nodeMigration").first();
    await ctx.db.patch(row!._id, { pinnedAccountsAt: 1 });
  });
}

describe("refused outside the pinned workspace", () => {
  test("setGrantees", async () => {
    const w = await world();
    expect(await save(w, w.acme, [{ accounts: true, role: "view" }])).toEqual({ ok: false, code: "GRANTEE_NOT_FOUND" });
    expect((await stateOf(w.t, w.acme)).grants).toEqual([]);
  });

  test("the console's All Context users tier", async () => {
    const w = await world();
    expect(await tier(w, w.acme, "team", { accounts: true })).toEqual({ ok: false, code: "NOT_FOUND" });
    expect((await stateOf(w.t, w.acme)).grants).toEqual([]);
  });

  test("setAccessRow", async () => {
    const w = await world();
    const answer = await w.t.run(async (ctx) =>
      await setAccessRow(ctx as unknown as MutationCtx, {
        workspaceId: w.acme,
        path: NOTE,
        base: "team",
        grantees: [{ kind: "accounts", role: "view" }],
        actor: { userId: w.staff, role: "owner" },
      }),
    );
    expect(answer).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("granting nothing outside the pinned workspace", () => {
  test("a grant written straight into the table is dropped on read, and kept in the pinned workspace", async () => {
    const w = await world();
    for (const workspaceId of [w.acme, w.pinned]) {
      await w.t.run(async (ctx) => {
        const row = await treeNodeAt(ctx.db, workspaceId, NOTE);
        await ctx.db.patch(row!._id, { access: { base: "private" } });
        await ctx.db.insert("nodeAccess", { workspaceId, nodeId: row!._id, granteeKind: "accounts", role: "view", at: 1, source: "owner" });
        await refreshSnapshot(ctx as unknown as MutationCtx, workspaceId);
      });
    }
    const kinds = (workspaceId: Id<"workspaces">) =>
      w.t.run(async (ctx) => (await accessRowsOf(ctx, workspaceId)).flatMap((row) => row.grantees.map((grantee) => grantee.kind)));
    expect(await kinds(w.acme)).toEqual([]);
    expect(await kinds(w.pinned)).toEqual(["accounts"]);
  });
});

describe("in the pinned workspace", () => {
  test("view only", async () => {
    const w = await world();
    expect(await save(w, w.pinned, [{ accounts: true, role: "edit" }])).toEqual({ ok: false, code: "GRANTEE_NOT_FOUND" });
    expect(await save(w, w.pinned, [{ accounts: true, role: "view" }])).toMatchObject({ ok: true });
    expect(await stateOf(w.t, w.pinned)).toEqual({ access: { base: "team" }, grants: ["accounts:view"] });
  });

  test("All Context users is base team plus the accounts grant", async () => {
    const w = await world();
    expect(await tier(w, w.pinned, "team", { accounts: true })).toMatchObject({ ok: true });
    expect(await stateOf(w.t, w.pinned)).toEqual({ access: { base: "team" }, grants: ["accounts:view"] });
  });

  test("Members before the migration is the old position, so the pin readers still reading team do not read it", async () => {
    const w = await world();
    expect(await tier(w, w.pinned, "team")).toMatchObject({ ok: true });
    expect(await stateOf(w.t, w.pinned)).toEqual({ access: { base: "private" }, grants: ["members:view"] });
  });

  test("Members after the migration is plain team, from the new spelling and the old", async () => {
    const w = await world();
    await flipSwitch(w.t);
    await tier(w, w.pinned, "team", { accounts: true });
    expect(await tier(w, w.pinned, "team")).toMatchObject({ ok: true });
    expect((await stateOf(w.t, w.pinned)).grants).toEqual([]);
    expect((await stateOf(w.t, w.pinned)).access?.base ?? "team").toBe("team");
    await tier(w, w.pinned, "private", { members: true });
    expect((await stateOf(w.t, w.pinned)).grants).toEqual([]);
    expect((await stateOf(w.t, w.pinned)).access?.base ?? "team").toBe("team");
  });

  test("Restricted clears the accounts grant", async () => {
    const w = await world();
    await tier(w, w.pinned, "team", { accounts: true });
    expect(await tier(w, w.pinned, "private")).toMatchObject({ ok: true });
    // Private is what the note inherits from the root, so it goes back to inheriting it.
    expect(await stateOf(w.t, w.pinned)).toEqual({ grants: [] });
  });

  test("an ordinary workspace's Members position is unchanged", async () => {
    const w = await world();
    await flipSwitch(w.t);
    await tier(w, w.acme, "private", { members: true });
    expect(await stateOf(w.t, w.acme)).toEqual({ access: { base: "private" }, grants: ["members:view"] });
  });
});
