/**
 * `internal.functions.gatewayHandles.resolve`: the gateway's handle cache asks which grantee an `@name` is, in one
 * workspace. Names only, never an address; a group of this workspace, or a person who exists; at most 100 a call.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - drop the `workspaceId` check in `resolveHandle`: "a group of another workspace" stops giving null;
 *  - drop the `ctx.db.get` check on the user: "a deleted person" resolves;
 *  - drop the `parseInvitee` name check: "an email-shaped string" resolves;
 *  - drop the `handles.slice(0, MAX_HANDLES)`: "more than 100 handles" answers all of them.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { asUser, createUser, createWorkspace } from "./fixtures.helpers";

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;

interface World {
  t: T;
  acme: Id<"workspaces">;
  beta: Id<"workspaces">;
  owner: Id<"users">;
  thatUser: Id<"users">;
  leads: Id<"workspaceGroups">;
  leadsName: string;
  crew: Id<"workspaceGroups">;
  crewName: string;
}

/**
 * Workspace "acme" with a group `leads`, workspace "globex" (another tenant) with a group `crew`, and a person who
 * has claimed the username `thatname` in the one global namespace.
 */
async function world(): Promise<World> {
  const t = makeTest();
  const owner = await createUser(t, "owner@example.test");
  const betaOwner = await createUser(t, "betaowner@example.test");
  const acme = await createWorkspace(t, owner, "acme", { kind: "shared", displayName: "Acme" });
  const beta = await createWorkspace(t, betaOwner, "globex", { kind: "shared", displayName: "Globex" });
  const leadsMade = await asUser(t, owner).mutation(api.functions.groups.createGroup, { workspaceId: acme, label: "leads" });
  const crewMade = await asUser(t, betaOwner).mutation(api.functions.groups.createGroup, { workspaceId: beta, label: "crew" });
  const thatUser = await createUser(t, "thatperson@example.test");
  await t.run(async (ctx) => {
    await ctx.db.insert("names", { name: "thatname", kind: "user", userId: thatUser, claimedBy: thatUser, claimedAt: Date.now() });
  });
  return {
    t,
    acme,
    beta,
    owner,
    thatUser,
    leads: leadsMade.groupId,
    leadsName: leadsMade.name,
    crew: crewMade.groupId,
    crewName: crewMade.name,
  };
}

const resolveIn = (t: T, workspaceId: Id<"workspaces">, handles: string[]) =>
  t.query(internal.functions.gatewayHandles.resolve, { workspaceId, handles });

describe("gatewayHandles.resolve", () => {
  test("a claimed username resolves to its person", async () => {
    const w = await world();
    expect(await resolveIn(w.t, w.acme, ["@thatname"])).toEqual([
      { handle: "@thatname", grantee: { kind: "user", id: w.thatUser } },
    ]);
  });

  test("a group of this workspace resolves to the group; a group of another workspace resolves to nothing", async () => {
    const w = await world();
    expect(await resolveIn(w.t, w.acme, [`@${w.leadsName}`])).toEqual([
      { handle: `@${w.leadsName}`, grantee: { kind: "group", id: w.leads } },
    ]);
    expect(await resolveIn(w.t, w.acme, [`@${w.crewName}`])).toEqual([
      { handle: `@${w.crewName}`, grantee: null },
    ]);
  });

  test("a name nobody holds is null, and an email-shaped string is null because only names resolve", async () => {
    const w = await world();
    // A verified account with this address exists: the answer is still null, since an address is never a grantee here.
    await w.t.run(async (ctx) => {
      await ctx.db.insert("users", { email: "a@example.com", emailVerificationTime: Date.now() } as never);
    });
    expect(await resolveIn(w.t, w.acme, ["@nobody-holds-this", "a@example.com"])).toEqual([
      { handle: "@nobody-holds-this", grantee: null },
      { handle: "a@example.com", grantee: null },
    ]);
  });

  test("a name whose user row was deleted is null, though its names row remains", async () => {
    const w = await world();
    const gone = await createUser(w.t, "gone@example.test");
    await w.t.run(async (ctx) => {
      await ctx.db.insert("names", { name: "goneperson", kind: "user", userId: gone, claimedBy: gone, claimedAt: Date.now() });
      await ctx.db.delete(gone);
      expect(await ctx.db.get(gone)).toBeNull();
      expect(await ctx.db.query("names").withIndex("by_name", (q) => q.eq("name", "goneperson")).unique()).not.toBeNull();
    });
    expect(await resolveIn(w.t, w.acme, ["@goneperson"])).toEqual([{ handle: "@goneperson", grantee: null }]);
  });

  test("more than 100 handles: only the first 100 are answered", async () => {
    const w = await world();
    // A claimed name at index 0 and at index 100: the one past the cap must not be answered.
    const handles = Array.from({ length: 150 }, (_, i) => (i === 0 || i >= 100 ? "@thatname" : `@nobody-${i}`));
    const answered = await resolveIn(w.t, w.acme, handles);
    expect(answered).toHaveLength(100);
    expect(answered.map((row) => row.handle)).toEqual(handles.slice(0, 100));
    expect(answered[0]).toEqual({ handle: "@thatname", grantee: { kind: "user", id: w.thatUser } });
  });
});
