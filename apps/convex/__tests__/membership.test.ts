/**
 * MEMBERSHIP — removing somebody, and changing what they may do.
 *
 * Two things are being proved.
 *
 * **Authority.** Only an `owner` may change who is in a context or what they
 * may do. An `editor` can write notes; that is not the same as being able to
 * decide who reads them. And the `owner` row itself is not removable or
 * demotable by anyone, because there is exactly one of them and a context with
 * none is unadministrable forever.
 *
 * **Revocation is immediate.** Removing somebody has to cut off the AI clients
 * they already connected — not when their token expires, not after a sweep, in
 * the same instant. The mechanism is that every path from a token to authority
 * re-reads membership, and there are three of them; the tests below drive all
 * three, because "we check it in the obvious place" is exactly the kind of
 * claim this repository has already been wrong about twice.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  joinViaInvitation,
  seedGrant,
  setupTest,
} from "./fixtures.helpers";

/** Serialize a thrown error's payload so two failures can be compared exactly. */
function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

/**
 * A shared context whose members got there the way the product says they do:
 * invited, then accepting.
 */
async function team() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const mallory = await createUser(t, "mallory@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "team-context", {
    kind: "shared",
    displayName: "Team Context",
  });
  await createWorkspace(t, mallory, "mallory-context");

  await joinViaInvitation(t, {
    workspaceId,
    owner,
    invitee: editor,
    addressedTo: "editor@example.invalid",
    role: "editor",
  });
  await joinViaInvitation(t, {
    workspaceId,
    owner,
    invitee: member,
    addressedTo: "member@example.invalid",
    role: "member",
  });

  return { t, owner, editor, member, mallory, workspaceId };
}

describe("removing a member is owner-only", () => {
  test("an owner can, and the person loses access immediately", async () => {
    const { t, owner, member, workspaceId } = await team();

    expect(
      await asUser(t, owner).mutation(api.functions.workspaces.removeMember, {
        workspaceId,
        userId: member,
      }),
    ).toEqual({ removed: true });

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, member).query(api.functions.workspaces.getWorkspace, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("WORKSPACE_NOT_FOUND");

    const members = await asUser(t, owner).query(
      api.functions.workspaces.listMembers,
      { workspaceId },
    );
    expect(members.map((m) => m.email)).toEqual([
      "owner@example.invalid",
      "editor@example.invalid",
    ]);
  });

  test("an editor cannot remove anybody, including a read-only member", async () => {
    const { t, editor, member, workspaceId } = await team();

    const error = await captureError(() =>
      asUser(t, editor).mutation(api.functions.workspaces.removeMember, {
        workspaceId,
        userId: member,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(
      (error as { data: { requiredRole: string; actualRole: string } }).data,
    ).toMatchObject({ requiredRole: "owner", actualRole: "editor" });

    expect(
      await asUser(t, member).query(api.functions.workspaces.getWorkspace, {
        workspaceId,
      }),
    ).toMatchObject({ slug: "team-context" });
  });

  test("a member cannot remove anybody either, not even themselves", async () => {
    const { t, member, editor, workspaceId } = await team();

    for (const target of [editor, member]) {
      expect(
        errorCode(
          await captureError(() =>
            asUser(t, member).mutation(api.functions.workspaces.removeMember, {
              workspaceId,
              userId: target,
            }),
          ),
        ),
      ).toBe("INSUFFICIENT_ROLE");
    }
  });

  test("a stranger is refused identically to a context that never existed", async () => {
    const { t, mallory, member, workspaceId } = await team();
    const dangling = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        slug: "temporary-placeholder",
        displayName: "Temporary",
        createdBy: mallory,
        kind: "personal" as const,
        structureTemplate: "para" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });

    const foreign = await captureError(() =>
      asUser(t, mallory).mutation(api.functions.workspaces.removeMember, {
        workspaceId,
        userId: member,
      }),
    );
    const nonexistent = await captureError(() =>
      asUser(t, mallory).mutation(api.functions.workspaces.removeMember, {
        workspaceId: dangling,
        userId: member,
      }),
    );

    expect(errorCode(foreign)).toBe("WORKSPACE_NOT_FOUND");
    expect(errorShape(foreign)).toBe(errorShape(nonexistent));
  });

  test("the owner cannot be removed, by anybody, including themselves", async () => {
    const { t, owner, workspaceId } = await team();

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.workspaces.removeMember, {
        workspaceId,
        userId: owner,
      }),
    );
    // A context whose only owner is gone has a storage credential, an audit
    // trail, and nobody who can rebind or wind it down. One click, no undo.
    expect(errorCode(error)).toBe("CANNOT_REMOVE_OWNER");
    expect(
      await asUser(t, owner).query(api.functions.workspaces.getWorkspace, {
        workspaceId,
      }),
    ).toMatchObject({ role: "owner" });
  });

  test("removing somebody who is not there is idempotent, not an error", async () => {
    const { t, owner, mallory, workspaceId } = await team();
    expect(
      await asUser(t, owner).mutation(api.functions.workspaces.removeMember, {
        workspaceId,
        userId: mallory,
      }),
    ).toEqual({ removed: false });
  });

  test("the removal names who did it and who it was", async () => {
    const { t, owner, member, workspaceId } = await team();
    await asUser(t, owner).mutation(api.functions.workspaces.removeMember, {
      workspaceId,
      userId: member,
    });

    const events = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    expect(events.find((e) => e.action === "member.removed")).toMatchObject({
      actorUserId: owner,
      details: { targetUserId: member, previousRole: "member" },
    });
  });
});

describe("changing a role is owner-only", () => {
  test("an owner can promote and demote between editor and member", async () => {
    const { t, owner, member, workspaceId } = await team();

    expect(
      await asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
        workspaceId,
        userId: member,
        role: "editor",
      }),
    ).toEqual({ role: "editor" });
    expect(
      (
        await asUser(t, owner).query(api.functions.workspaces.listMembers, {
          workspaceId,
        })
      ).find((m) => m.userId === member)?.role,
    ).toBe("editor");

    expect(
      await asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
        workspaceId,
        userId: member,
        role: "member",
      }),
    ).toEqual({ role: "member" });
  });

  test("an editor cannot promote themselves", async () => {
    const { t, editor, workspaceId } = await team();

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, editor).mutation(api.functions.workspaces.setMemberRole, {
            workspaceId,
            userId: editor,
            role: "editor",
          }),
        ),
      ),
    ).toBe("INSUFFICIENT_ROLE");
  });

  test("a member cannot promote themselves to editor", async () => {
    const { t, member, workspaceId } = await team();

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, member).mutation(api.functions.workspaces.setMemberRole, {
            workspaceId,
            userId: member,
            role: "editor",
          }),
        ),
      ),
    ).toBe("INSUFFICIENT_ROLE");

    // ...and is still read-only, which is the thing that actually matters.
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, member).mutation(api.functions.storage.disconnectStorage, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("INSUFFICIENT_ROLE");
  });

  test("no role change can mint an owner", async () => {
    const { t, owner, member, workspaceId } = await team();
    await expect(
      asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
        workspaceId,
        userId: member,
        // @ts-expect-error — the point of the test is that this is not a role.
        role: "owner",
      }),
    ).rejects.toThrow();

    expect(
      (
        await asUser(t, owner).query(api.functions.workspaces.listMembers, {
          workspaceId,
        })
      ).filter((m) => m.role === "owner"),
    ).toHaveLength(1);
  });

  test("the owner's own role cannot be changed", async () => {
    const { t, owner, workspaceId } = await team();
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
            workspaceId,
            userId: owner,
            role: "editor",
          }),
        ),
      ),
    ).toBe("CANNOT_CHANGE_OWNER_ROLE");
  });

  test("somebody who is not a member has no role to set", async () => {
    const { t, owner, mallory, workspaceId } = await team();
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
            workspaceId,
            userId: mallory,
            role: "member",
          }),
        ),
      ),
    ).toBe("MEMBER_NOT_FOUND");
  });

  test("setting the role somebody already has records nothing", async () => {
    const { t, owner, editor, workspaceId } = await team();
    await asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
      workspaceId,
      userId: editor,
      role: "editor",
    });

    const events = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    expect(events.filter((e) => e.action === "member.role_changed")).toEqual([]);
  });

  test("a real change names the actor and both roles", async () => {
    const { t, owner, member, workspaceId } = await team();
    await asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
      workspaceId,
      userId: member,
      role: "editor",
    });

    const events = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    expect(events.find((e) => e.action === "member.role_changed")).toMatchObject({
      actorUserId: owner,
      details: { targetUserId: member, previousRole: "member", role: "editor" },
    });
  });
});

/**
 * The claim under test: removing somebody cuts off the AI clients they already
 * connected, in the same instant, without anything having to sweep or revoke.
 *
 * There are three routes from a token to authority and all three are exercised
 * here, because a fix that only covered the obvious one would still leave a
 * removed person able to refresh their way back in.
 */
describe("removing a member cuts off their already-issued grants", () => {
  test("an inbound MCP request stops resolving", async () => {
    const { t, owner, editor, workspaceId } = await team();
    // A live grant, exactly as the gateway would have created one.
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("oauthGrants", {
        workspaceId,
        userId: editor,
        clientId: "claude",
        scopes: ["context.read", "context.write"],
        hashedRefreshToken: "a".repeat(64),
        hashedAccessToken: "b".repeat(64),
        accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
        status: "active" as const,
        createdAt: Date.now(),
      });
      await ctx.db.insert("oauthClients", {
        clientId: "claude",
        clientName: "Claude",
        redirectUris: ["https://client.invalid/callback"],
        hashedClientSecret: null,
        createdAt: Date.now(),
      });
      return id;
    });

    const before = await t.query(
      internal.functions.controlPlane.resolveGrantByAccessToken,
      { hashedAccessToken: "b".repeat(64) },
    );
    expect(before).toMatchObject({ workspaceId, role: "editor" });

    await asUser(t, owner).mutation(api.functions.workspaces.removeMember, {
      workspaceId,
      userId: editor,
    });

    // No sweep, no revocation list, no waiting for the token to expire.
    expect(
      await t.query(internal.functions.controlPlane.resolveGrantByAccessToken, {
        hashedAccessToken: "b".repeat(64),
      }),
    ).toBeNull();
  });

  test("the refresh token stops resolving too", async () => {
    const { t, owner, member, workspaceId } = await team();
    await seedGrant(t, workspaceId, member, "chatgpt", "c".repeat(64));

    expect(
      await t.query(internal.functions.grants.resolveGrantByRefreshToken, {
        hashedRefreshToken: "c".repeat(64),
      }),
    ).toMatchObject({ workspaceId, role: "member" });

    await asUser(t, owner).mutation(api.functions.workspaces.removeMember, {
      workspaceId,
      userId: member,
    });

    expect(
      await t.query(internal.functions.grants.resolveGrantByRefreshToken, {
        hashedRefreshToken: "c".repeat(64),
      }),
    ).toBeNull();
  });

  test("a removed person cannot refresh their way back in", async () => {
    const { t, owner, member, workspaceId } = await team();
    await seedGrant(t, workspaceId, member, "chatgpt", "d".repeat(64));

    await asUser(t, owner).mutation(api.functions.workspaces.removeMember, {
      workspaceId,
      userId: member,
    });

    // Rotation is the route a fix aimed only at resolution would miss: it holds
    // a valid refresh token and mints a *new* access token from it.
    expect(
      await t.mutation(internal.functions.controlPlane.rotateGrant, {
        hashedRefreshToken: "d".repeat(64),
        clientId: "chatgpt",
        newHashedRefreshToken: "e".repeat(64),
        newHashedAccessToken: "f".repeat(64),
        accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
        scopes: null,
      }),
    ).toBeNull();
  });

  test("only the removed person is cut off — the rest of the context keeps working", async () => {
    const { t, owner, editor, member, workspaceId } = await team();
    await seedGrant(t, workspaceId, editor, "claude", "1".repeat(64));
    await seedGrant(t, workspaceId, member, "chatgpt", "2".repeat(64));

    await asUser(t, owner).mutation(api.functions.workspaces.removeMember, {
      workspaceId,
      userId: member,
    });

    expect(
      await t.query(internal.functions.grants.resolveGrantByRefreshToken, {
        hashedRefreshToken: "1".repeat(64),
      }),
    ).toMatchObject({ userId: editor, role: "editor" });
    expect(
      await t.query(internal.functions.grants.resolveGrantByRefreshToken, {
        hashedRefreshToken: "2".repeat(64),
      }),
    ).toBeNull();
  });

  test("a demotion is reflected in what a live grant may do", async () => {
    const { t, owner, editor, workspaceId } = await team();
    await seedGrant(t, workspaceId, editor, "claude", "3".repeat(64));

    await asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
      workspaceId,
      userId: editor,
      role: "member",
    });

    // The gateway intersects the grant's scopes with what the role permits, so
    // the role travelling with every resolution is what makes a demotion take
    // effect on an already-connected client rather than on the next login.
    expect(
      await t.query(internal.functions.grants.resolveGrantByRefreshToken, {
        hashedRefreshToken: "3".repeat(64),
      }),
    ).toMatchObject({ role: "member" });
  });

  test("re-inviting somebody does not resurrect their old clients", async () => {
    const { t, owner, member, workspaceId } = await team();
    await seedGrant(t, workspaceId, member, "chatgpt", "4".repeat(64));

    await asUser(t, owner).mutation(api.functions.workspaces.removeMember, {
      workspaceId,
      userId: member,
    });
    await joinViaInvitation(t, {
      workspaceId,
      owner,
      invitee: member,
      addressedTo: "member@example.invalid",
      role: "member",
    });

    // Membership is live, so the old grant resolves again. That is the honest
    // consequence of "check membership on every call" rather than "revoke on
    // removal", and it is recorded here so a future change to revoke-on-removal
    // is a deliberate decision with a failing test attached, not a silent one.
    expect(
      await t.query(internal.functions.grants.resolveGrantByRefreshToken, {
        hashedRefreshToken: "4".repeat(64),
      }),
    ).toMatchObject({ workspaceId, userId: member });
  });
});

describe("a context has exactly one owner, always", () => {
  test("nothing in the invitation or role flows can create a second", async () => {
    const { t, owner, editor, member, workspaceId } = await team();
    // Everything a caller can reach, aimed at making somebody an owner.
    await asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
      workspaceId,
      userId: editor,
      role: "editor",
    });
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "member@example.invalid",
      role: "editor",
    });

    const members = await asUser(t, owner).query(
      api.functions.workspaces.listMembers,
      { workspaceId },
    );
    expect(members.filter((m) => m.role === "owner").map((m) => m.userId)).toEqual([
      owner,
    ]);
    expect(members.find((m) => m.userId === member)?.role).toBe("member");
  });

  test("the invariant is what makes a handle resolve to one person", async () => {
    // `@name` addresses the sole owner of the personal context called `name`.
    // If a personal context could have two owners, that resolution would have
    // to pick — and `resolveInviteeUser` fails closed instead. This asserts the
    // premise rather than the fallback.
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    const personal = await createWorkspace(t, alice, "alice-context");
    await addMember(t, personal, bob, "editor", alice);

    const members = await asUser(t, alice).query(
      api.functions.workspaces.listMembers,
      { workspaceId: personal },
    );
    expect(members.filter((m) => m.role === "owner")).toHaveLength(1);
  });
});

describe("leaving a context is the member's own move", () => {
  test("an editor can walk out, and the audit says they left rather than were removed", async () => {
    const { t, owner, editor, workspaceId } = await team();

    expect(
      await asUser(t, editor).mutation(api.functions.workspaces.leaveWorkspace, {
        workspaceId,
      }),
    ).toEqual({ left: true });

    // Gone means gone: the workspace no longer answers to them at all.
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, editor).query(api.functions.workspaces.getWorkspace, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("WORKSPACE_NOT_FOUND");

    // "member.left", not "member.removed" — who initiated it is exactly what
    // an audit trail exists to answer.
    const events = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    expect(events.map((event) => event.action)).toContain("member.left");
  });

  test("an owner cannot leave — that would be an ownership transfer in disguise", async () => {
    const { t, owner, workspaceId } = await team();
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, owner).mutation(api.functions.workspaces.leaveWorkspace, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("OWNER_CANNOT_LEAVE");
  });

  test("leaving a context you were never in is a quiet no", async () => {
    const { t, mallory, workspaceId } = await team();
    expect(
      await asUser(t, mallory).mutation(api.functions.workspaces.leaveWorkspace, {
        workspaceId,
      }),
    ).toEqual({ left: false });
  });
});
