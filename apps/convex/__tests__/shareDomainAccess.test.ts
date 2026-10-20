import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * A SHARE PAGE'S WAY IN THROUGH AN EMAIL DOMAIN (Dev, 2026-10-20).
 *
 * A link to a note in a workspace opened to a domain tells its reader the
 * domain, so the page can say "sign in with your @domain email to edit". It
 * never names the workspace to somebody who could not join it, and it hands
 * the slug only to a signed-in reader with a confirmed address there, who
 * `myDomainWorkspaces` already lists it to.
 */

const TOKEN = "a".repeat(64);
const ENTRY = "1-projects/onboarding/prep.md";

async function world(t: TestConvex, role: "editor" | "member" = "editor") {
  const owner = await createUser(t, "seyi@publicworship.org");
  const team = await createWorkspace(t, owner, "pw", { kind: "shared" });
  await t.run(async (ctx) => {
    await ctx.db.insert("workspaceDomains", {
      workspaceId: team,
      domain: "publicworship.org",
      role,
      enabled: true,
      addedBy: owner,
      addedAt: Date.now(),
    });
    await ctx.db.insert("noteShares", {
      workspaceId: team,
      entryPath: ENTRY,
      recipientKind: "anyone",
      recipient: "",
      createdBy: owner,
      token: TOKEN,
      status: "active",
      titleInPreview: true,
      createdAt: Date.now(),
    });
  });
  return { owner, team };
}

async function grantFor(t: TestConvex, actorUserId: Id<"users"> | null) {
  const grant = await t.query(internal.functions.shares.authorizeShareRead, { actorUserId, token: TOKEN });
  if (grant === null) throw new Error("the link should stand");
  return grant;
}

describe("a link into a workspace opened to a domain", () => {
  test("tells a reader with no session the domain, and nothing that names the workspace", async () => {
    const t = setupTest();
    await world(t);
    const grant = await grantFor(t, null);
    expect(grant.domainAccess).toEqual({ domain: "publicworship.org", canEdit: true, joinSlug: null });
    expect(JSON.stringify(grant.domainAccess)).not.toContain("pw");
  });

  test("says when joining that way only reads", async () => {
    const t = setupTest();
    await world(t, "member");
    expect((await grantFor(t, null)).domainAccess).toEqual({
      domain: "publicworship.org",
      canEdit: false,
      joinSlug: null,
    });
  });

  test("a signed-in reader at another address is told the domain, not the slug", async () => {
    const t = setupTest();
    await world(t);
    const ada = await createUser(t, "ada@gmail.com");
    expect((await grantFor(t, ada)).domainAccess).toEqual({
      domain: "publicworship.org",
      canEdit: true,
      joinSlug: null,
    });
  });

  test("a signed-in reader with a confirmed address there is given the slug to join", async () => {
    const t = setupTest();
    await world(t);
    const tobi = await createUser(t, "tobi@publicworship.org");
    expect((await grantFor(t, tobi)).domainAccess).toEqual({
      domain: "publicworship.org",
      canEdit: true,
      joinSlug: "pw",
    });
  });

  test("an address added on Account settings counts the same as the main one", async () => {
    const t = setupTest();
    await world(t);
    const tobi = await createUser(t, "tobi@gmail.com");
    await t.run(async (ctx) => {
      await ctx.db.insert("signInEmails", { userId: tobi, email: "tobi@publicworship.org", addedAt: Date.now() });
    });
    expect((await grantFor(t, tobi)).domainAccess?.joinSlug).toBe("pw");
  });

  test("a member is told nothing: an editor is sent to the console, and a member is in already", async () => {
    const t = setupTest();
    const { owner, team } = await world(t);
    const reader = await createUser(t, "reader@publicworship.org");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceMembers", { workspaceId: team, userId: reader, role: "member", joinedAt: Date.now() });
    });
    const ownerGrant = await grantFor(t, owner);
    expect(ownerGrant.editableInContext).toBe("pw");
    expect(ownerGrant.domainAccess).toBeNull();
    expect((await grantFor(t, reader)).domainAccess).toBeNull();
  });

  test("a domain switched off says nothing, as a workspace with none does", async () => {
    const t = setupTest();
    const { team } = await world(t);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceDomains")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", team))
        .first();
      await ctx.db.patch(row!._id, { enabled: false });
    });
    expect((await grantFor(t, null)).domainAccess).toBeNull();
  });

  test("of two domains, the one the reader holds wins, then the one that edits", async () => {
    const t = setupTest();
    const { owner, team } = await world(t, "member");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceDomains", {
        workspaceId: team,
        domain: "pwstudio.org",
        role: "editor",
        enabled: true,
        addedBy: owner,
        addedAt: Date.now() + 1,
      });
    });
    expect((await grantFor(t, null)).domainAccess?.domain).toBe("pwstudio.org");
    const tobi = await createUser(t, "tobi@publicworship.org");
    expect((await grantFor(t, tobi)).domainAccess).toEqual({
      domain: "publicworship.org",
      canEdit: false,
      joinSlug: "pw",
    });
  });
});

describe("the sign-in page's hint", () => {
  test("names the domain for an unlisted link, read with no session", async () => {
    const t = setupTest();
    await world(t);
    expect(await t.query(api.functions.shares.shareSignInHint, { token: TOKEN })).toEqual({
      domain: "publicworship.org",
      canEdit: true,
    });
  });

  test("says nothing for a token nobody minted, or a link that needs a session", async () => {
    const t = setupTest();
    const { team } = await world(t);
    expect(await t.query(api.functions.shares.shareSignInHint, { token: "b".repeat(64) })).toBeNull();
    await t.run(async (ctx) => {
      const share = await ctx.db.query("noteShares").withIndex("by_token", (q) => q.eq("token", TOKEN)).unique();
      await ctx.db.patch(share!._id, { recipientKind: "members" });
    });
    expect(team).toBeDefined();
    expect(await t.query(api.functions.shares.shareSignInHint, { token: TOKEN })).toBeNull();
  });
});
