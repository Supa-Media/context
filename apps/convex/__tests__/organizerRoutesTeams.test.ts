/**
 * Which teams a personal workspace may write notes for
 * (`organizerRoutes.writableTeams`), read live from membership.
 *
 * A note is only ever sent where its owner may write: a shared workspace they
 * own or edit. Never one where they are a reader, never somebody else's
 * personal workspace, and a shared workspace's own sweep has no teams at all.
 *
 * Sabotage checked by hand:
 *   admitting role "member"                   → "a workspace they only read is not a team" fails
 *   dropping the kind === "shared" check      → "a personal workspace is never a team" fails
 *   dropping the owner check on the personal  → "only the owner of the personal workspace has teams" fails
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

type Harness = ReturnType<typeof convexTest>;
type Role = "owner" | "editor" | "member";

async function user(t: Harness, email: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => await ctx.db.insert("users", { email, emailVerificationTime: Date.now() } as never));
}

async function workspace(t: Harness, slug: string, kind: "personal" | "shared", members: [Id<"users">, Role][]): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      slug,
      displayName: slug.toUpperCase(),
      createdBy: members[0]![0],
      kind,
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    for (const [userId, role] of members) await ctx.db.insert("workspaceMembers", { workspaceId, userId, role, joinedAt: now });
    return workspaceId;
  });
}

async function setUp() {
  const t = convexTest(schema, modules);
  const seyi = await user(t, "seyi@example.test");
  const sayo = await user(t, "sayo@example.test");
  const personal = await workspace(t, "seyi", "personal", [[seyi, "owner"]]);
  const sayosOwn = await workspace(t, "sayo", "personal", [[sayo, "owner"], [seyi, "editor"]]);
  await workspace(t, "supa", "shared", [[seyi, "owner"], [sayo, "editor"]]);
  await workspace(t, "public-worship", "shared", [[sayo, "owner"], [seyi, "editor"]]);
  await workspace(t, "context-lc", "shared", [[sayo, "owner"], [seyi, "member"]]);
  await workspace(t, "elsewhere", "shared", [[sayo, "owner"]]);
  const shared = await workspace(t, "studio", "shared", [[seyi, "owner"]]);
  return { t, seyi, sayo, personal, sayosOwn, shared };
}

const teams = (t: Harness, workspaceId: Id<"workspaces">, userId: Id<"users">) =>
  t.query(internal.functions.organizerRoutes.writableTeams, { workspaceId, userId });

describe("a personal workspace's teams", () => {
  test("shared workspaces they own or edit, by @name", async () => {
    const { t, seyi, personal } = await setUp();
    expect((await teams(t, personal, seyi)).map((team) => [team.name, team.title])).toEqual([
      ["@public-worship", "PUBLIC-WORSHIP"],
      ["@studio", "STUDIO"],
      ["@supa", "SUPA"],
    ]);
  });

  test("a workspace they only read is not a team, and one they aren't in doesn't exist", async () => {
    const { t, seyi, personal } = await setUp();
    const names = (await teams(t, personal, seyi)).map((team) => team.name);
    expect(names).not.toContain("@context-lc");
    expect(names).not.toContain("@elsewhere");
  });

  test("a personal workspace is never a team, even one they edit", async () => {
    const { t, seyi, personal } = await setUp();
    expect((await teams(t, personal, seyi)).map((team) => team.name)).not.toContain("@sayo");
  });

  test("only the owner of the personal workspace has teams, and a shared workspace has none", async () => {
    const { t, seyi, sayo, personal, sayosOwn, shared } = await setUp();
    expect(await teams(t, sayosOwn, seyi)).toEqual([]);
    expect(await teams(t, personal, sayo)).toEqual([]);
    expect(await teams(t, shared, seyi)).toEqual([]);
  });
});
