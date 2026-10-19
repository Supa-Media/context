/**
 * The share dialog's Members position: a row's base `private` plus the built-in `members` grantee
 * (`docs/decisions/privacy-and-sharing/all-context-users.md`). In the pinned workspace that is how a note is kept
 * to the people actually invited, because `team` there reaches every Context account through the pin.
 *
 *  - `shareList` reports the grant, with the live member count, so the dialog can tell Members from Restricted.
 *  - `setGrantees` takes it (`{ members: true }`) and keeps it when the dialog sends a list back.
 *  - `consoleAccess` sets it with `members: true` (base `private`, the rest of the list kept) and clears it on any
 *    other tier, so Restricted and All Context users never leave a hidden members grant behind.
 *  - `setNoteVisibility` carries `members` through to the rows, and refuses it where the rows are not the truth.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - drop the `members` branch in `entriesOf` (`shareList.ts`): "reports a members grant" fails;
 *  - map a `{ members: true }` request to nothing in `resolveEntry`: "takes the members grantee" fails;
 *  - drop the `members` case from `granteeInputOf`: `addGrantees.test.ts` "a members grant stays" fails;
 *  - keep the members grant on a tier write in `consoleAccess` (`listForTier`): "Restricted clears it" and
 *    "All Context users clears it" fail;
 *  - drop the people already listed in `listForTier`: "keeps everybody else on the list" fails;
 *  - let `members` through in file mode in `setNoteVisibilityHandler`: "refused outside rows mode" fails;
 *  - mark only the pin's row `everyAccountReadsTeam` in `lib/workspaces/list.ts`, not a real member's:
 *    "everybody's row says its team tier is every account" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { convexTest } from "convex-test";
import { modules } from "../../test.setup";
import { asUser, addMember, captureError, createUser, createWorkspace, errorCode, setupTest } from "../fixtures.helpers";
import { fixture as filesFixture } from "../files/fixtures.helpers";

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;

async function person(t: T, email: string, name?: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => await ctx.db.insert("users", { email, name, emailVerificationTime: Date.now() } as never));
}

const PLAN = "1-projects/plan.md";

async function world() {
  const t = makeTest();
  const owner = await person(t, "owner@example.test", "Owner");
  const member = await person(t, "member@example.test", "Mel");
  const kola = await person(t, "kola@example.test", "Kola");
  const ws = await createWorkspace(t, owner, "acme", { kind: "shared", displayName: "Acme" });
  await addMember(t, ws, member, "member", owner);
  await addMember(t, ws, kola, "editor", owner);
  await t.run(async (ctx) => {
    await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    for (const path of ["1-projects", PLAN]) {
      await ctx.db.insert("nodes", {
        workspaceId: ws,
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        kind: path.endsWith(".md") ? "file" : "folder",
        observedAt: 1,
      });
    }
  });
  return { t, ws, owner, member, kola };
}
type World = Awaited<ReturnType<typeof world>>;

const list = (w: World, path = PLAN) =>
  asUser(w.t, w.owner).query(api.functions.nodesAccess.shareList, { workspaceId: w.ws, path });

function save(w: World, grantees: Array<Record<string, unknown>>, base?: "private" | "team" | "inherit") {
  return asUser(w.t, w.owner).mutation(api.functions.nodesAccess.setGrantees, {
    workspaceId: w.ws,
    path: PLAN,
    grantees: grantees as never,
    ...(base === undefined ? {} : { base }),
  });
}

function tier(w: World, to: "private" | "team", members?: boolean) {
  return w.t.mutation(internal.functions.nodesAccess.consoleAccess, {
    workspaceId: w.ws,
    actorUserId: w.owner,
    path: PLAN,
    kind: "note",
    tier: to,
    ...(members === undefined ? {} : { members }),
  });
}

async function accessOn(w: World) {
  return await w.t.run(async (ctx) => {
    const row = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws).eq("path", PLAN)).unique();
    return row?.access;
  });
}

describe("the list reports a members grant", () => {
  test("reports a members grant, with how many members there are", async () => {
    const w = await world();
    expect(await save(w, [{ members: true, role: "view" }], "private")).toMatchObject({ ok: true });
    const answer = await list(w);
    expect(answer).toMatchObject({ base: "private", tier: "private", from: null });
    expect(answer?.grantees).toEqual([{ kind: "members", role: "view", count: 3 }]);
  });
});

describe("setGrantees", () => {
  test("takes the members grantee, and keeps it when the dialog sends the list back with someone added", async () => {
    const w = await world();
    expect(await save(w, [{ members: true, role: "view" }], "private")).toMatchObject({ ok: true });
    expect(await save(w, [{ members: true, role: "view" }, { email: "pat@example.test", role: "view" }], "private")).toMatchObject({ ok: true });
    expect((await list(w))?.grantees.map((entry) => entry.kind).sort()).toEqual(["email", "members"]);
  });

  test("an entry that names members and anything else is a request error", async () => {
    const w = await world();
    expect(await save(w, [{ members: true, email: "pat@example.test", role: "view" }], "private")).toEqual({ ok: false, code: "INVALID" });
  });
});

describe("the general access control", () => {
  test("Members writes base private plus the members grant", async () => {
    const w = await world();
    expect(await tier(w, "private", true)).toMatchObject({ ok: true });
    expect(await accessOn(w)).toEqual({ base: "private" });
    expect((await list(w))?.grantees).toEqual([{ kind: "members", role: "view", count: 3 }]);
  });

  test("Members keeps everybody else on the list", async () => {
    const w = await world();
    await save(w, [{ email: "pat@example.test", role: "edit" }], "team");
    expect(await tier(w, "private", true)).toMatchObject({ ok: true });
    expect(await accessOn(w)).toEqual({ base: "private" });
    const kinds = (await list(w))?.grantees.map((entry) => `${entry.kind}:${entry.role}`).sort();
    expect(kinds).toEqual(["email:edit", "members:view"]);
  });

  test("Restricted clears it, and keeps the people named", async () => {
    const w = await world();
    await save(w, [{ members: true, role: "view" }, { email: "pat@example.test", role: "view" }], "private");
    expect(await tier(w, "private")).toMatchObject({ ok: true });
    expect((await list(w))?.grantees).toEqual([{ kind: "email", email: "pat@example.test", role: "view" }]);
  });

  test("All Context users clears it", async () => {
    const w = await world();
    await save(w, [{ members: true, role: "view" }], "private");
    expect(await tier(w, "team")).toMatchObject({ ok: true, visibility: "team" });
    expect((await list(w))?.grantees).toEqual([]);
    // Nothing else on the list and the folder says nothing either, so the note keeps the tier it was given.
    expect(await accessOn(w)).toEqual({ base: "team" });
  });
});

describe("the console's note verb", () => {
  test("carries members to the rows", async () => {
    const f = await filesFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    });
    const owner = asUser(f.t, f.owner);
    await owner.action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
      visibility: "private",
      members: true,
    });
    const answer = await owner.query(api.functions.nodesAccess.shareList, { workspaceId: f.workspaceId, path: "1-projects/shared.md" });
    expect(answer).toMatchObject({ base: "private" });
    expect(answer?.grantees.map((entry) => entry.kind)).toEqual(["members"]);
  });

  test("refused outside rows mode, and nothing is written", async () => {
    const f = await filesFixture();
    const owner = asUser(f.t, f.owner);
    const before = f.backend.snapshot();
    const error = await captureError(() =>
      owner.action(api.functions.files.setNoteVisibility, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        visibility: "private",
        members: true,
      }),
    );
    expect(errorCode(error)).toBe("NOT_ROWS_MODE");
    expect(f.backend.snapshot()).toEqual(before);
  });

  test("members with team is a request error", async () => {
    const f = await filesFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    });
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        visibility: "team",
        members: true,
      }),
    );
    expect(errorCode(error)).toBe("INVALID");
  });
});

describe("the console says where team reaches every account", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("everybody's row says its team tier is every account, the real members' rows included", async () => {
    const t = setupTest();
    // The pinned workspace as it really is: shared, created by an address the deployment trusts.
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
    const staff = await createUser(t, "staff@example.invalid");
    await createWorkspace(t, staff, "staff-personal");
    const pinnedId = await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
    const sayo = await createUser(t, "sayo@example.invalid");
    await createWorkspace(t, sayo, "sayo");
    const pinRow = (await asUser(t, sayo).query(api.functions.workspaces.listMyWorkspaces, {})).find(
      (w) => w.workspaceId === pinnedId,
    );
    const staffRows = await asUser(t, staff).query(api.functions.workspaces.listMyWorkspaces, {});
    // The share dialog is the owner's, and the owner is a real member: the flag cannot be the pin's alone.
    expect(pinRow?.everyAccountReadsTeam).toBe(true);
    expect(staffRows.find((w) => w.workspaceId === pinnedId)).toMatchObject({ role: "owner", everyAccountReadsTeam: true });
    expect(staffRows.find((w) => w.workspaceId === pinnedId)?.pinned).toBeUndefined();
    expect(staffRows.find((w) => w.slug === "staff-personal")?.everyAccountReadsTeam).toBeUndefined();
  });
});
