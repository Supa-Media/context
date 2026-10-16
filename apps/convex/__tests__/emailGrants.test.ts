/**
 * Email grants match a member's confirmed addresses (`grantedNamesFor` in rows mode).
 *
 * An owner names a person by email on a note's list (`nodeAccess` with `granteeKind: "email"`). The
 * grant reaches a member only when that address is one the member has proved they read: the main
 * `users.email` once verified, or an added sign-in email. A verified address that two accounts hold
 * matches neither of them. Non-members get nothing, as before.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - drop the `accountForEmail === userId` check in `ownedConfirmedEmailsOf`: "an address two accounts hold grants neither" fails;
 *  - drop `emails` from the `accessNamesFor` call in `grantedNames.ts`: "an added, confirmed address grants the note" fails;
 *  - cap the list at ten addresses (`slice(0, MAX_EMAILS_PER_ACCOUNT)`) so the eleventh, a main plus ten added, is dropped:
 *    "a full account ... grants on the newest added address" fails;
 *  - count `users.email` without `emailVerificationTime` as confirmed, in `confirmedEmailsOf` AND in `accountsForEmail`
 *    (its `verifiedOnly` default): "an unverified users.email grants nothing" fails. One layer alone is not enough:
 *    the ownership lookup refuses an unverified address too, so the test is a guard only when both are broken.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import schema from "../schema";
import { modules } from "../test.setup";
import { grantedNamesFor } from "../functions/lib/grantedNames";
import { setAccessRow } from "../functions/lib/nodes/setAccess";
import { asUser, addMember, createWorkspace } from "./fixtures.helpers";

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;

const PLAN = "1-projects/plan.md";
const KOLA_WORK = "kola.work@example.test";

interface World {
  t: T;
  ws: Id<"workspaces">;
  beta: Id<"workspaces">;
  owner: Id<"users">;
  ownerB: Id<"users">;
  kola: Id<"users">;
  bob: Id<"users">;
  carol: Id<"users">;
}

async function world(): Promise<World> {
  const t = makeTest();
  const now = Date.now();
  const verified = (email: string) => t.run((ctx) => ctx.db.insert("users", { email, emailVerificationTime: now } as never));
  const owner = await verified("owner@example.test");
  const ownerB = await verified("ownerb@example.test");
  const kola = await verified("kola@example.test");
  const bob = await verified("bob@example.test");
  const carol = await verified("carol@example.test");
  await t.run((ctx) => ctx.db.insert("signInEmails", { userId: kola, email: KOLA_WORK, addedAt: now }));
  const ws = await createWorkspace(t, owner, "acme", { kind: "shared", displayName: "Acme" });
  await addMember(t, ws, kola, "member", owner);
  await addMember(t, ws, bob, "member", owner);
  const beta = await createWorkspace(t, ownerB, "globex", { kind: "shared", displayName: "Globex" });
  await addMember(t, beta, kola, "member", ownerB);
  await t.run(async (ctx) => {
    await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
  });
  for (const [workspace, actor] of [
    [ws, owner],
    [beta, ownerB],
  ] as const) {
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: workspace,
      at: 10,
      rows: ["1-projects/", PLAN].map((path) => ({ path, etag: `e-${path}`, size: 1 })),
      gone: [],
      vanishedUnder: [],
    });
    await t.mutation(internal.functions.nodes.begin, { workspaceId: workspace, at: 5 });
    await t.mutation(internal.functions.nodes.finish, { workspaceId: workspace, at: 20, files: 2 });
    // The folder is team and the note is private: the note is visible only through its list.
    await t.run(async (ctx) => {
      await setAccessRow(ctx as unknown as MutationCtx, { workspaceId: workspace, path: "1-projects", base: "team", actor: { userId: actor, role: "owner" } });
      await setAccessRow(ctx as unknown as MutationCtx, { workspaceId: workspace, path: PLAN, base: "private", actor: { userId: actor, role: "owner" } });
    });
  }
  return { t, ws, beta, owner, ownerB, kola, bob, carol };
}

async function emailGrant(w: World, email: string, workspace = w.ws, who = w.owner) {
  return asUser(w.t, who).mutation(api.functions.nodesAccess.setGrantees, {
    workspaceId: workspace,
    path: PLAN,
    grantees: [{ email, role: "view" }] as never,
  });
}

async function noteTokenOf(w: World, workspace = w.ws): Promise<string> {
  return await w.t.run(async (ctx) => {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspace).eq("path", PLAN))
      .unique();
    if (row === null) throw new Error(`no row at ${PLAN}`);
    return `#${row.noteId ?? row._id}`;
  });
}

/** The entries a member sees in the team folder that holds the note. */
async function folderNamesFor(w: World, who: Id<"users">, workspace = w.ws): Promise<string[]> {
  const listing = await asUser(w.t, who).query(api.functions.nodesListing.listFolder, { workspaceId: workspace, path: "1-projects" });
  return (listing?.entries ?? []).map((entry) => entry.path.slice(entry.path.lastIndexOf("/") + 1)).sort();
}

async function namesFor(w: World, who: Id<"users">, workspace = w.ws): Promise<string[]> {
  return await w.t.run(async (ctx) => await grantedNamesFor(ctx as unknown as QueryCtx, workspace, who));
}

describe("an added, confirmed address grants a member the note", () => {
  test("a member's added sign-in email, granted view on a private note, reads it", async () => {
    const w = await world();
    expect(await folderNamesFor(w, w.kola)).toEqual([]);
    expect(await emailGrant(w, "  Kola.Work@Example.TEST ")).toMatchObject({ ok: true });
    expect(await namesFor(w, w.kola)).toContain(await noteTokenOf(w));
    expect(await folderNamesFor(w, w.kola)).toEqual(["plan.md"]);
    // Another member, who holds no such address, still does not see it.
    expect(await folderNamesFor(w, w.bob)).toEqual([]);
    expect(await namesFor(w, w.bob)).toEqual([]);
  });

  test("a full account, a verified main address and ten added ones, grants on the newest added address", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      // KOLA_WORK from `world()` is the first of the ten added; these eight and the newest make ten.
      for (let i = 1; i <= 8; i += 1) {
        await ctx.db.insert("signInEmails", { userId: w.kola, email: `kola.${i}@example.test`, addedAt: 1000 + i });
      }
      await ctx.db.insert("signInEmails", { userId: w.kola, email: "kola.newest@example.test", addedAt: 2000 });
    });
    expect(await emailGrant(w, "kola.newest@example.test")).toMatchObject({ ok: true });
    expect(await folderNamesFor(w, w.kola)).toEqual(["plan.md"]);
  });

  test("a member's main address, once verified, grants the note the same way", async () => {
    const w = await world();
    expect(await emailGrant(w, "bob@example.test")).toMatchObject({ ok: true });
    expect(await folderNamesFor(w, w.bob)).toEqual(["plan.md"]);
    expect(await folderNamesFor(w, w.kola)).toEqual([]);
  });

  test("removing the sign-in email row ends the access", async () => {
    const w = await world();
    await emailGrant(w, KOLA_WORK);
    expect(await folderNamesFor(w, w.kola)).toEqual(["plan.md"]);
    await w.t.run(async (ctx) => {
      const rows = await ctx.db.query("signInEmails").withIndex("by_user", (q) => q.eq("userId", w.kola)).collect();
      for (const row of rows) await ctx.db.delete(row._id);
    });
    expect(await folderNamesFor(w, w.kola)).toEqual([]);
    expect(await namesFor(w, w.kola)).toEqual([]);
  });
});

describe("an address that is not a member's own, confirmed address grants nothing", () => {
  test("an unverified users.email grants nothing", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.patch(w.bob, { email: "bob.old@example.test", emailVerificationTime: undefined }));
    expect(await emailGrant(w, "bob.old@example.test")).toMatchObject({ ok: true });
    expect(await folderNamesFor(w, w.bob)).toEqual([]);
    expect(await namesFor(w, w.bob)).toEqual([]);
  });

  test("an address two accounts hold grants neither of them", async () => {
    const w = await world();
    const shared = "shared.inbox@example.test";
    await w.t.run(async (ctx) => {
      await ctx.db.insert("signInEmails", { userId: w.kola, email: shared, addedAt: 1 });
      await ctx.db.insert("signInEmails", { userId: w.bob, email: shared, addedAt: 1 });
    });
    expect(await emailGrant(w, shared)).toMatchObject({ ok: true });
    expect(await folderNamesFor(w, w.kola)).toEqual([]);
    expect(await folderNamesFor(w, w.bob)).toEqual([]);
    expect(await namesFor(w, w.kola)).toEqual([]);
    expect(await namesFor(w, w.bob)).toEqual([]);
  });

  test("an email grant in workspace B gives nothing in workspace A", async () => {
    const w = await world();
    expect(await emailGrant(w, KOLA_WORK, w.beta, w.ownerB)).toMatchObject({ ok: true });
    expect(await namesFor(w, w.kola, w.beta)).toContain(await noteTokenOf(w, w.beta));
    expect(await namesFor(w, w.kola, w.ws)).toEqual([]);
    expect(await folderNamesFor(w, w.kola, w.ws)).toEqual([]);
  });

  test("a non-member whose address is granted still gets nothing", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.insert("signInEmails", { userId: w.carol, email: "carol.work@example.test", addedAt: 1 }));
    expect(await emailGrant(w, "carol.work@example.test")).toMatchObject({ ok: true });
    expect(await namesFor(w, w.carol)).toEqual([]);
  });
});
