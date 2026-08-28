/**
 * Account deletion.
 *
 * The two things that must hold no matter what changes here:
 *  - deleting yourself removes every row that is *yours* — the user row, your
 *    auth material, your memberships, your name claims, and any workspace only
 *    you own, including its storage binding and its slug, so the person can
 *    re-onboard under the same name; and
 *  - deleting yourself removes nothing that is *somebody else's* — a workspace
 *    with another owner survives untouched, and so does everyone else's
 *    membership of it.
 *
 * The cascade assertions below deliberately check the *pre*-state first. An
 * "is empty afterwards" assertion over a table the fixture never populated is
 * vacuously green, and a cascade that silently stopped touching a table would
 * sail through it.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedGrant,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";

/**
 * A user with a personal workspace and a storage binding — the ordinary shape
 * of an account that has finished onboarding.
 *
 * `seedStorageBinding` rather than `bindFakeStorage`, for the reason the
 * fixture itself gives: the real action schedules a verification probe that
 * races the test, and what is under test here is the deletion, not the
 * connect.
 */
async function onboardedAccount(slug = "atlas") {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, slug);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  return { t, owner, workspaceId };
}

/** Auth rows as @convex-dev/auth lays them down for a signed-in account. */
async function seedAuthRows(t: TestConvex, userId: Id<"users">) {
  const accountId = await t.run((ctx) =>
    ctx.db.insert("authAccounts", {
      userId,
      provider: "email-otp",
      providerAccountId: "owner@example.invalid",
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("authVerificationCodes", {
      accountId,
      provider: "email-otp",
      code: "fake-hashed-code-not-real",
      expirationTime: Date.now() + 86_400_000,
    }),
  );
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86_400_000,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("authRefreshTokens", {
      sessionId,
      expirationTime: Date.now() + 86_400_000,
    }),
  );
  return { accountId, sessionId };
}

describe("deleteAccount", () => {
  test("a sole owner's deletion cascades through the whole workspace and frees its slug", async () => {
    const { t, owner, workspaceId } = await onboardedAccount("atlas");
    await seedAuthRows(t, owner);
    await seedGrant(t, workspaceId, owner, "client-claude", "fake-hash-1");

    // Rows the cascade must reach that the fixture does not create on its own.
    // Inserted directly — each is a shape the product writes through its own
    // flow, and the test is about the deletion, not those flows.
    await t.run(async (ctx) => {
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: owner,
        action: "storage.bound",
        paths: [],
        at: Date.now(),
      });
      await ctx.db.insert("workspaceInvitations", {
        workspaceId,
        inviteeKind: "email",
        invitee: "friend@example.invalid",
        role: "member",
        invitedBy: owner,
        token: "fake-invitation-token-not-real",
        status: "pending",
        expiresAt: Date.now() + 86_400_000,
        createdAt: Date.now(),
      });
      await ctx.db.insert("dropboxConnectAttempts", {
        hashedState: "fake-hashed-state-not-real",
        encryptedVerifier: "v2:current:FAKE:VERIFIER",
        workspaceId,
        startedBy: owner,
        redirectUri: "https://console.example/callback",
        expiresAt: Date.now() + 600_000,
        createdAt: Date.now(),
      });
      await ctx.db.insert("ingestionTickets", {
        hashedTicket: "fake-hashed-ticket-not-real",
        workspaceId,
        sizeBytes: 1_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
      });
      await ctx.db.insert("cloudflareProvisioning", {
        workspaceId,
        requestedBy: owner,
        credentialSource: "api-token",
        accountId: "fake-cf-account-id",
        bucket: "example-context-bucket",
        jurisdiction: "default",
        status: "failed",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    // The pre-state: every table the cascade claims to touch really has a row
    // pointed at this workspace or this user. Without this, the emptiness
    // assertions below cannot fail.
    await t.run(async (ctx) => {
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
      expect(await ctx.db.query("storageBindings").collect()).toHaveLength(1);
      expect(await ctx.db.query("workspaceMembers").collect()).toHaveLength(1);
      expect(await ctx.db.query("ingestionSettings").collect()).toHaveLength(1);
      expect(await ctx.db.query("names").collect()).toHaveLength(1);
      expect(await ctx.db.query("oauthGrants").collect()).toHaveLength(1);
      expect(await ctx.db.query("authAccounts").collect()).toHaveLength(1);
      expect(await ctx.db.query("authSessions").collect()).toHaveLength(1);
    });

    const result = await asUser(t, owner).mutation(
      api.functions.account.deleteAccount,
      {},
    );
    expect(result).toEqual({ deleted: true });

    await t.run(async (ctx) => {
      // The person, and everything that authenticated them.
      expect(await ctx.db.get(owner)).toBeNull();
      expect(await ctx.db.query("authAccounts").collect()).toHaveLength(0);
      expect(await ctx.db.query("authVerificationCodes").collect()).toHaveLength(0);
      expect(await ctx.db.query("authSessions").collect()).toHaveLength(0);
      expect(await ctx.db.query("authRefreshTokens").collect()).toHaveLength(0);

      // The workspace and everything hanging off it.
      expect(await ctx.db.get(workspaceId)).toBeNull();
      expect(await ctx.db.query("workspaceMembers").collect()).toHaveLength(0);
      expect(await ctx.db.query("storageBindings").collect()).toHaveLength(0);
      expect(await ctx.db.query("ingestionSettings").collect()).toHaveLength(0);
      expect(await ctx.db.query("workspaceInvitations").collect()).toHaveLength(0);
      expect(await ctx.db.query("auditEvents").collect()).toHaveLength(0);
      expect(await ctx.db.query("dropboxConnectAttempts").collect()).toHaveLength(0);
      expect(await ctx.db.query("ingestionTickets").collect()).toHaveLength(0);
      expect(await ctx.db.query("cloudflareProvisioning").collect()).toHaveLength(0);
      expect(await ctx.db.query("oauthGrants").collect()).toHaveLength(0);

      // The slug: no row left in the shared namespace. This is the point of
      // the cascade — deletion must not squat the name forever.
      expect(await ctx.db.query("names").collect()).toHaveLength(0);
    });

    // And prove it, the way a real person would notice: somebody else can now
    // claim the same name and re-onboard.
    const successor = await createUser(t, "successor@example.invalid");
    const reclaimed = await createWorkspace(t, successor, "atlas");
    expect(reclaimed).toBeDefined();
  });

  test("deleting a Dropbox-backed account schedules the grant revocation", async () => {
    const { t, owner } = await onboardedAccount();

    // Reshape the fixture's bucket binding into a Dropbox one. Direct db
    // writes, exactly as storage.test.ts does for `disconnectStorage`: what is
    // under test is the deletion, not the connect flow.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("storageBindings").unique();
      await ctx.db.patch(row!._id, {
        provider: "dropbox",
        encryptedRefreshToken: "v2:current:FAKE:ENVELOPE",
        endpoint: undefined,
        region: undefined,
        bucket: undefined,
        accessKeyId: undefined,
        encryptedSecretAccessKey: undefined,
      });
    });

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});

    // The row is gone AND the revoke is on the schedule, carrying the envelope
    // it can no longer read from the row. Without this, we forget our copy of
    // the credential while the grant lives on in the person's Dropbox — the
    // same trap `disconnectStorage` closes, and an account deletion must not
    // reopen it.
    const rows = await t.run((ctx) => ctx.db.query("storageBindings").collect());
    expect(rows).toHaveLength(0);
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const revokes = scheduled.filter((job) =>
      job.name.includes("revokeDropboxGrant"),
    );
    expect(revokes).toHaveLength(1);
    expect(JSON.stringify(revokes[0].args)).toContain("v2:current:FAKE:ENVELOPE");
  });

  test("a member's deletion removes only their own membership, never the workspace", async () => {
    const { t, owner, workspaceId } = await onboardedAccount();
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "member", owner);

    await asUser(t, member).mutation(api.functions.account.deleteAccount, {});

    await t.run(async (ctx) => {
      // The member is gone, membership included.
      expect(await ctx.db.get(member)).toBeNull();
      const memberships = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect();
      expect(memberships.map((m) => m.userId)).toEqual([owner]);

      // The workspace, its owner, and its storage are untouched. This is the
      // half of the contract that protects everybody else.
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
      expect(await ctx.db.get(owner)).not.toBeNull();
      expect(await ctx.db.query("storageBindings").collect()).toHaveLength(1);
      expect(await ctx.db.query("names").collect()).toHaveLength(1);
    });
  });

  test("a co-owner's deletion leaves the workspace with the surviving owner", async () => {
    const { t, owner, workspaceId } = await onboardedAccount();
    const coOwner = await createUser(t, "co-owner@example.invalid");
    await addMember(t, workspaceId, coOwner, "owner", owner);

    await asUser(t, coOwner).mutation(api.functions.account.deleteAccount, {});

    await t.run(async (ctx) => {
      expect(await ctx.db.get(coOwner)).toBeNull();
      // Another owner remains, so nothing of theirs may cascade: the
      // workspace, the surviving owner's membership, and the binding all
      // stand.
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
      const memberships = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect();
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({ userId: owner, role: "owner" });
      expect(await ctx.db.query("storageBindings").collect()).toHaveLength(1);
    });
  });

  test("requires authentication", async () => {
    const t = setupTest();
    const error = await captureError(() =>
      t.mutation(api.functions.account.deleteAccount, {}),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });
});

describe("a freed name inherits nothing", () => {
  /**
   * The invitation model resolves an addressee only at accept time — which is
   * right for email and for the enumeration defence, and is exactly why a
   * freed name is dangerous: a pending invitation to `@atlas` in somebody
   * else's workspace would be acceptable by the name's NEXT owner. Deletion
   * therefore voids pending invitations addressed to every name it releases.
   */
  test("pending invitations to the deleted name die with the account", async () => {
    const { t, owner } = await onboardedAccount("atlas");
    const friend = await createUser(t, "friend@example.invalid");
    const friendWorkspace = await createWorkspace(t, friend, "friends-place", {
      kind: "shared",
      displayName: "Friend's Place",
    });
    await asUser(t, friend).mutation(api.functions.invitations.inviteMember, {
      workspaceId: friendWorkspace,
      invitee: "@atlas",
      role: "editor",
    });

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});

    // The row is gone outright — not expired, not declined: those are the
    // inviter's history, and this was never accepted by anybody.
    const leftover = await t.run((ctx) =>
      ctx.db
        .query("workspaceInvitations")
        .withIndex("by_invitee", (q) => q.eq("inviteeKind", "name").eq("invitee", "atlas"))
        .collect(),
    );
    expect(leftover).toEqual([]);

    // And the successor who claims the freed name starts with exactly one
    // context: their own.
    const successor = await createUser(t, "successor@example.invalid");
    await createWorkspace(t, successor, "atlas");
    const reachable = await asUser(t, successor).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(reachable.map((w) => w.slug)).toEqual(["atlas"]);
  });

  test("the inviter's history in OTHER states survives — only pending is a live key", async () => {
    const { t, owner } = await onboardedAccount("atlas");
    const friend = await createUser(t, "friend@example.invalid");
    const friendWorkspace = await createWorkspace(t, friend, "friends-place", {
      kind: "shared",
      displayName: "Friend's Place",
    });
    await asUser(t, friend).mutation(api.functions.invitations.inviteMember, {
      workspaceId: friendWorkspace,
      invitee: "@atlas",
      role: "editor",
    });
    // Mark it declined by hand: what matters is the status, not the journey.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceInvitations")
        .withIndex("by_invitee", (q) => q.eq("inviteeKind", "name").eq("invitee", "atlas"))
        .unique();
      await ctx.db.patch(row!._id, { status: "declined" });
    });

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});

    const kept = await t.run((ctx) =>
      ctx.db
        .query("workspaceInvitations")
        .withIndex("by_invitee", (q) => q.eq("inviteeKind", "name").eq("invitee", "atlas"))
        .collect(),
    );
    expect(kept.map((row) => row.status)).toEqual(["declined"]);
  });
});
