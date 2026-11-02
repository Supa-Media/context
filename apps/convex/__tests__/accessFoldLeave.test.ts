/**
 * Dropped-domain leaves and account folds on workspaces whose members are decided in their object
 * (`functions/lib/domainMembership.ts`, `functions/lib/account/foldIn.ts`, `functions/lib/accessHandOff/fold.ts`,
 * `functions/accessTakeAway.ts`; decided by the owner, 2026-11-01: `docs/decisions/identity-and-access/access-in-objects.md`).
 *
 * Covers:
 * - A dropped domain on `object` queues a `leave` and deletes nothing until the object took it; on `convex` the
 *   membership goes at once with no queue row; a refusing object leaves the membership and the queue row in place.
 * - A fold on `object` writes Convex first (no throw), queues a `fold`, and its run puts the new account before it
 *   removes the old one; the queue row is gone after.
 * - The fold's exemption is narrow: a raw membership delete on `object` is refused without a fold row, and a fold row
 *   exempts only its own two accounts, never a third member of the same workspace.
 *
 * Every value is fake (example.com). The object is a fake recording every call as {workspaceId, op, keys}.
 *
 * Sabotage, each confirmed to fail a case here: let a fold row exempt every membership write; never queue a dropped
 * domain's leave; skip the fold's member put in the object.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { runTakeAway, type OpenObject } from "../functions/accessTakeAway";
import { leaveDroppedDomains } from "../functions/lib/domainMembership";
import { foldIn } from "../functions/lib/account/foldIn";
import { watchDb } from "../functions/lib/rowWatch/watch";
import { flushAccessWrites, WORKSPACE_SWITCHED } from "../functions/lib/accessHandOff/flush";
import { addMember, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";

type Home = "convex" | "dual" | "object";
type Call = { workspaceId: string; op: string; keys: string[] };

/** The object's side of a take-away. Records every call; answers `{ error }` for all of them while refusing. */
function fakeObjects() {
  const calls: Call[] = [];
  let refusing = false;
  const answer = (workspaceId: Id<"workspaces">, op: string, keys: string[], ok: unknown) => {
    calls.push({ workspaceId: String(workspaceId), op, keys });
    return refusing ? { error: "refused" } : ok;
  };
  const open: OpenObject = (workspaceId) => ({
    members: {
      remove: async (userIds) => answer(workspaceId, "members.remove", userIds, { removed: userIds.length }),
      put: async (rows: unknown[]) =>
        answer(workspaceId, "members.put", rows.map((row: unknown) => String((row as { userId: string }).userId)), { kept: rows.length }),
    },
    invites: { remove: async (ids) => answer(workspaceId, "invites.remove", ids, { removed: ids.length }) },
    access: {
      connections: { revoke: async (grantId) => answer(workspaceId, "connections.revoke", [grantId], { revoked: true }) },
    },
  });
  return { calls, open, refuse: (value: boolean) => (refusing = value) };
}

async function setHomes(t: TestConvex, workspaceId: Id<"workspaces">, homes: { access?: Home; personAccess?: Home }) {
  await t.run(async (ctx) => {
    const held = await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (held === null) await ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "bucket", since: 0, ...homes });
    else await ctx.db.patch(held._id, homes);
  });
}

/** Run `fn` the way a mutation does: its database watched, and its access writes flushed. Throws as the mutation would. */
async function watchedRun(t: TestConvex, fn: (ctx: MutationCtx) => Promise<unknown>): Promise<void> {
  await t.run(async (ctx) => {
    const watch = watchDb(ctx.db);
    const watched = { ...ctx, db: watch.db };
    await fn(watched);
    await flushAccessWrites(watched, watch.accessWrites, { writeBehind: false });
  });
}

async function runQueued(t: TestConvex, id: Id<"accessTakeAways">, fake: ReturnType<typeof fakeObjects>) {
  return await t.action(async (ctx) => await runTakeAway(ctx, id, fake.open));
}

const queue = (t: TestConvex) => t.run((ctx) => ctx.db.query("accessTakeAways").collect());

const membershipOf = (t: TestConvex, workspaceId: Id<"workspaces">, userId: Id<"users">) =>
  t.run((ctx) =>
    ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
      .unique(),
  );

// ---------------------------------------------------------------------------------------------------------------------
// A. Dropped domain leave
// ---------------------------------------------------------------------------------------------------------------------

/** A shared workspace, and a member who joined through example.com but signs in only with other.example now. */
async function domainWorld() {
  const t = setupTest();
  const owner = await createUser(t, "domain-owner@example.com");
  const shared = await createWorkspace(t, owner, "domain-shared", { kind: "shared" });
  const leaver = await createUser(t, "domain-leaver@other.example");
  await t.run((ctx) =>
    ctx.db.insert("workspaceMembers", { workspaceId: shared, userId: leaver, role: "member", viaDomain: "example.com", joinedAt: 1 }),
  );
  return { t, owner, shared, leaver };
}

describe("a dropped domain leaves a workspace on object", () => {
  test("queues a leave and keeps the membership; the run removes it in the object, then in Convex", async () => {
    const { t, shared, leaver } = await domainWorld();
    await setHomes(t, shared, { access: "object" });

    await watchedRun(t, (ctx) => leaveDroppedDomains(ctx, leaver));
    const rows = await queue(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "leave", userId: leaver, workspaceIds: [shared] });
    expect(await membershipOf(t, shared, leaver)).not.toBeNull();

    const fake = fakeObjects();
    expect(await runQueued(t, rows[0]._id, fake)).toBe("done");
    expect(fake.calls).toEqual([{ workspaceId: String(shared), op: "members.remove", keys: [String(leaver)] }]);
    expect(await membershipOf(t, shared, leaver)).toBeNull();
    expect(await queue(t)).toEqual([]);
  });

  test("on convex the membership goes at once and nothing is queued", async () => {
    const { t, shared, leaver } = await domainWorld();
    await setHomes(t, shared, { access: "convex" });

    await watchedRun(t, (ctx) => leaveDroppedDomains(ctx, leaver));
    expect(await membershipOf(t, shared, leaver)).toBeNull();
    expect(await queue(t)).toEqual([]);
  });

  test("a refusing object leaves the membership and the queue row in place", async () => {
    const { t, shared, leaver } = await domainWorld();
    await setHomes(t, shared, { access: "object" });
    await watchedRun(t, (ctx) => leaveDroppedDomains(ctx, leaver));
    const [row] = await queue(t);

    const fake = fakeObjects();
    fake.refuse(true);
    expect(await runQueued(t, row._id, fake)).toBe("failed");
    expect(fake.calls).toHaveLength(1);
    expect(await membershipOf(t, shared, leaver)).not.toBeNull();
    expect(await queue(t)).toEqual([row]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// B. Fold
// ---------------------------------------------------------------------------------------------------------------------

/** A shared workspace on object-or-convex with one member who owns nothing, and one account with a personal workspace. */
async function foldWorld() {
  const t = setupTest();
  const owner = await createUser(t, "fold-owner@example.com");
  const shared = await createWorkspace(t, owner, "fold-shared", { kind: "shared" });
  const fromId = await createUser(t, "fold-from@example.com");
  const intoId = await createUser(t, "fold-into@example.com");
  await createWorkspace(t, intoId, "fold-into");
  await addMember(t, shared, fromId, "member", owner);
  return { t, owner, shared, fromId, intoId };
}

describe("folding an account into another on object", () => {
  test("writes Convex first without throwing, queues a fold; the run puts the new account, then removes the old", async () => {
    const { t, shared, fromId, intoId } = await foldWorld();
    await setHomes(t, shared, { access: "object" });

    await watchedRun(t, (ctx) => foldIn(ctx, fromId, intoId));
    expect(await membershipOf(t, shared, fromId)).toBeNull();
    expect(await membershipOf(t, shared, intoId)).toMatchObject({ role: "member" });
    const rows = await queue(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "fold", userId: fromId, intoId, workspaceIds: [shared] });

    const fake = fakeObjects();
    expect(await runQueued(t, rows[0]._id, fake)).toBe("done");
    expect(fake.calls.map((call) => [call.op, call.keys])).toEqual([
      ["members.put", [String(intoId)]],
      ["members.remove", [String(fromId)]],
    ]);
    expect(await queue(t)).toEqual([]);
  });

  test("without a fold row, a raw membership delete on object is refused", async () => {
    const { t, owner, shared } = await foldWorld();
    const guest = await createUser(t, "fold-guest@example.com");
    await addMember(t, shared, guest, "member", owner);
    await setHomes(t, shared, { access: "object" });
    const row = await membershipOf(t, shared, guest);

    const refused = await watchedRun(t, (ctx) => ctx.db.delete(row!._id)).catch((error) => error);
    expect(errorCode(refused)).toBe(WORKSPACE_SWITCHED);
    expect(await membershipOf(t, shared, guest)).not.toBeNull();
  });

  test("a fold row exempts its own two accounts only, never a third member of the same workspace", async () => {
    const { t, owner, shared, fromId, intoId } = await foldWorld();
    const third = await createUser(t, "fold-third@example.com");
    await addMember(t, shared, third, "member", owner);
    await setHomes(t, shared, { access: "object" });
    await t.run((ctx) =>
      ctx.db.insert("accessTakeAways", { kind: "fold", userId: fromId, intoId, workspaceIds: [shared], at: Date.now(), attempt: 0 }),
    );

    const thirdRow = await membershipOf(t, shared, third);
    const refused = await watchedRun(t, (ctx) => ctx.db.delete(thirdRow!._id)).catch((error) => error);
    expect(errorCode(refused)).toBe(WORKSPACE_SWITCHED);
    expect(await membershipOf(t, shared, third)).not.toBeNull();

    // Contrast: the same fold row does cover the folding account's own row, so the write goes through.
    const fromRow = await membershipOf(t, shared, fromId);
    await watchedRun(t, (ctx) => ctx.db.delete(fromRow!._id));
    expect(await membershipOf(t, shared, fromId)).toBeNull();
  });
});
