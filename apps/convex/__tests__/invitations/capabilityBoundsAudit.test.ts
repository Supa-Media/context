import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  errorCode,
  pendingInvitationToken,
} from "../fixtures.helpers";
import {
  errorShape,
  shared,
  danglingInvitationId,
  expire,
} from "./fixtures";

describe("an invitation is a capability, and it is bound to a person", () => {
  test("holding somebody else's token is worth nothing", async () => {
    const { t, owner, bob, mallory, workspaceId } = await shared();

    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "editor",
    });
    const token = (await pendingInvitationToken(t, bob, workspaceId)) as string;

    const stolen = await captureError(() =>
      asUser(t, mallory).mutation(api.functions.invitations.acceptInvitation, {
        token,
      }),
    );
    const imaginary = await captureError(() =>
      asUser(t, mallory).mutation(api.functions.invitations.acceptInvitation, {
        token: "0".repeat(64),
      }),
    );

    expect(errorCode(stolen)).toBe("INVITATION_NOT_FOUND");
    // Byte-identical: a stolen token must not confirm that it is a real one.
    expect(errorShape(stolen)).toBe(errorShape(imaginary));

    // And it still works for the person it was addressed to.
    await asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, {
      token,
    });
    expect(
      (
        await asUser(t, owner).query(api.functions.workspaces.listMembers, {
          workspaceId,
        })
      ).find((m) => m.userId === mallory),
    ).toBeUndefined();
  });

  test("declining somebody else's invitation is refused the same way", async () => {
    const { t, owner, bob, mallory, workspaceId } = await shared();
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const token = (await pendingInvitationToken(t, bob, workspaceId)) as string;

    const stolen = await captureError(() =>
      asUser(t, mallory).mutation(api.functions.invitations.declineInvitation, {
        token,
      }),
    );
    expect(errorCode(stolen)).toBe("INVITATION_NOT_FOUND");

    // Untouched: Mallory cannot burn an invitation she was not sent.
    expect(await pendingInvitationToken(t, bob, workspaceId)).toBe(token);
  });

  test("a token is single-use", async () => {
    const { t, owner, bob, workspaceId } = await shared();
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const token = (await pendingInvitationToken(t, bob, workspaceId)) as string;

    await asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, {
      token,
    });
    const second = await captureError(() =>
      asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, { token }),
    );
    const imaginary = await captureError(() =>
      asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, {
        token: "0".repeat(64),
      }),
    );

    expect(errorCode(second)).toBe("INVITATION_NOT_FOUND");
    // A spent token must not be distinguishable from one that never existed,
    // or it becomes a probe for "was this a real invitation?".
    expect(errorShape(second)).toBe(errorShape(imaginary));
  });

  test("a declined token cannot be replayed", async () => {
    const { t, owner, bob, workspaceId } = await shared();
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const token = (await pendingInvitationToken(t, bob, workspaceId)) as string;

    await asUser(t, bob).mutation(api.functions.invitations.declineInvitation, {
      token,
    });
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, {
            token,
          }),
        ),
      ),
    ).toBe("INVITATION_NOT_FOUND");
  });

  test("an expired invitation is refused identically to one that never existed", async () => {
    const { t, owner, bob, workspaceId } = await shared();
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const token = (await pendingInvitationToken(t, bob, workspaceId)) as string;
    await expire(t, token);

    const stale = await captureError(() =>
      asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, { token }),
    );
    const imaginary = await captureError(() =>
      asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, {
        token: "0".repeat(64),
      }),
    );
    expect(errorCode(stale)).toBe("INVITATION_NOT_FOUND");
    expect(errorShape(stale)).toBe(errorShape(imaginary));

    // Gone from both listings too, without anyone having to sweep it.
    expect(
      await asUser(t, owner).query(api.functions.invitations.listInvitations, {
        workspaceId,
      }),
    ).toEqual([]);
    expect(
      await asUser(t, bob).query(api.functions.invitations.listMyInvitations, {}),
    ).toEqual([]);
  });

  test("re-inviting retires the previous token instead of stacking a second row", async () => {
    const { t, owner, bob, workspaceId } = await shared();
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const first = (await pendingInvitationToken(t, bob, workspaceId)) as string;

    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "editor",
    });
    const second = (await pendingInvitationToken(t, bob, workspaceId)) as string;

    expect(second).not.toBe(first);
    expect(
      await asUser(t, owner).query(api.functions.invitations.listInvitations, {
        workspaceId,
      }),
    ).toHaveLength(1);

    // The superseded token is dead — otherwise "re-send the invitation" would
    // quietly leave the old link live, and a link forwarded by mistake would
    // stay spendable after the owner thought they had replaced it.
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, {
            token: first,
          }),
        ),
      ),
    ).toBe("INVITATION_NOT_FOUND");

    // The new one carries the new role.
    await asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, {
      token: second,
    });
    const members = await asUser(t, owner).query(
      api.functions.workspaces.listMembers,
      { workspaceId },
    );
    expect(members.find((m) => m.userId === bob)?.role).toBe("editor");
  });

  test("accepting when you are already a member spends the token and changes nothing", async () => {
    const { t, owner, bob, workspaceId } = await shared();
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const token = (await pendingInvitationToken(t, bob, workspaceId)) as string;

    // Bob gets in another way before answering, as an editor.
    await addMember(t, workspaceId, bob, "editor", owner);

    const result = await asUser(t, bob).mutation(
      api.functions.invitations.acceptInvitation,
      { token },
    );
    // No demotion from clicking a stale link.
    expect(result.role).toBe("editor");
    const members = await asUser(t, owner).query(
      api.functions.workspaces.listMembers,
      { workspaceId },
    );
    expect(members.filter((m) => m.userId === bob)).toHaveLength(1);
    expect(members.find((m) => m.userId === bob)?.role).toBe("editor");
  });
});

describe("withdrawing an invitation", () => {
  test("an owner can, and the token dies with it", async () => {
    const { t, owner, bob, workspaceId } = await shared();
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const token = (await pendingInvitationToken(t, bob, workspaceId)) as string;
    const [pending] = await asUser(t, owner).query(
      api.functions.invitations.listInvitations,
      { workspaceId },
    );

    expect(
      await asUser(t, owner).mutation(api.functions.invitations.revokeInvitation, {
        invitationId: pending.invitationId,
      }),
    ).toEqual({ revoked: true });

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, {
            token,
          }),
        ),
      ),
    ).toBe("INVITATION_NOT_FOUND");
    expect(
      await asUser(t, owner).query(api.functions.invitations.listInvitations, {
        workspaceId,
      }),
    ).toEqual([]);
  });

  test("an editor is told which role it needs, because they could already see it", async () => {
    const { t, owner, bob, carol, workspaceId } = await shared();
    await addMember(t, workspaceId, carol, "editor", owner);
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const [pending] = await asUser(t, carol).query(
      api.functions.invitations.listInvitations,
      { workspaceId },
    );

    const error = await captureError(() =>
      asUser(t, carol).mutation(api.functions.invitations.revokeInvitation, {
        invitationId: pending.invitationId,
      }),
    );
    // Unlike `revokeGrant`'s rule for a read-only member, naming the role leaks
    // nothing here: `listInvitations` already showed Carol this exact row.
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("a stranger is refused identically to an invitation that never existed", async () => {
    const { t, owner, mallory, workspaceId } = await shared();
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const [pending] = await asUser(t, owner).query(
      api.functions.invitations.listInvitations,
      { workspaceId },
    );
    const dangling = await danglingInvitationId(t, workspaceId, owner);

    const foreign = await captureError(() =>
      asUser(t, mallory).mutation(api.functions.invitations.revokeInvitation, {
        invitationId: pending.invitationId,
      }),
    );
    const nonexistent = await captureError(() =>
      asUser(t, mallory).mutation(api.functions.invitations.revokeInvitation, {
        invitationId: dangling,
      }),
    );

    expect(errorCode(foreign)).toBe("INVITATION_NOT_FOUND");
    expect(errorShape(foreign)).toBe(errorShape(nonexistent));
  });

  test("a stranger cannot list a context's invitations at all", async () => {
    const { t, owner, mallory, workspaceId } = await shared();
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, mallory).query(api.functions.invitations.listInvitations, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("bounds", () => {
  test("invitations are rate limited", async () => {
    const { t, owner, workspaceId } = await shared();
    for (let i = 0; i < 20; i += 1) {
      await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
        workspaceId,
        invitee: `@candidate-${i}`,
        role: "member",
      });
    }
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
        workspaceId,
        invitee: "@one-too-many",
        role: "member",
      }),
    );
    expect(errorCode(error)).toBe("RATE_LIMITED");
  });

  test("a context cannot accumulate unbounded outstanding invitations", async () => {
    const { t, owner, workspaceId } = await shared();
    // Seeded directly: the hourly rate limit means a hundred honest invitations
    // cannot be made in one test, and what is under test here is the cap on the
    // *table*, not the cap on the rate.
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i += 1) {
        await ctx.db.insert("workspaceInvitations", {
          workspaceId,
          inviteeKind: "name" as const,
          invitee: `seeded-${i}`,
          role: "member" as const,
          invitedBy: owner,
          token: `seeded-token-${i}`,
          status: "pending" as const,
          expiresAt: Date.now() + 60_000,
          createdAt: Date.now(),
        });
      }
    });

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
        workspaceId,
        invitee: "@one-too-many",
        role: "member",
      }),
    );
    expect(errorCode(error)).toBe("INVITATION_LIMIT_REACHED");

    // Refreshing one that already exists is still allowed — the cap is on how
    // many people are outstanding, not on how many times you may re-send.
    expect(
      await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
        workspaceId,
        invitee: "@seeded-0",
        role: "editor",
      }),
    ).toBeNull();
  });

  test("answered invitations never crowd the live ones out of the listing", async () => {
    const { t, owner, bob, workspaceId } = await shared();
    // More answered rows than the listing's window, seeded directly because the
    // rate limit makes three hundred honest invitations impossible in a test.
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i += 1) {
        await ctx.db.insert("workspaceInvitations", {
          workspaceId,
          inviteeKind: "name" as const,
          invitee: `answered-${i}`,
          role: "member" as const,
          invitedBy: owner,
          token: `answered-token-${i}`,
          status: "accepted" as const,
          expiresAt: Date.now() + 60_000,
          createdAt: Date.now(),
          respondedAt: Date.now(),
        });
      }
    });

    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });

    // A bounded read over every row in the table would have returned two
    // hundred dead ones and none of this. Narrowing in the index is what makes
    // the bound apply to what is being listed.
    const pending = await asUser(t, owner).query(
      api.functions.invitations.listInvitations,
      { workspaceId },
    );
    expect(pending.map((row) => row.invitee)).toEqual(["@bob-context"]);
    expect(await pendingInvitationToken(t, bob, workspaceId)).not.toBeNull();
  });

  test("the sweep removes long-dead rows and nothing else", async () => {
    const { t, owner, bob, workspaceId } = await shared();
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const live = (await pendingInvitationToken(t, bob, workspaceId)) as string;

    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@long-gone",
      role: "member",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceInvitations")
        .withIndex("by_invitee", (q) =>
          q.eq("inviteeKind", "name").eq("invitee", "long-gone"),
        )
        .unique();
      // Expired, and expired long enough ago to be past the retention grace.
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 2 * 60 * 60 * 1000 });
    });

    const { internal } = await import("../../_generated/api");
    const result = await t.mutation(
      internal.functions.invitations.purgeExpiredInvitations,
      {},
    );
    expect(result).toEqual({ deleted: 1, moreRemaining: false });

    // The live one is untouched, and still answerable.
    await asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, {
      token: live,
    });
  });
});

describe("the audit trail records who acted", () => {
  test("an invitation and a joining both name the acting identity", async () => {
    const { t, owner, bob, workspaceId } = await shared();
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "bob@example.invalid",
      role: "editor",
    });
    const token = (await pendingInvitationToken(t, bob, workspaceId)) as string;
    await asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, {
      token,
    });

    const events = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    const byAction = new Map(events.map((e) => [e.action, e]));

    expect(byAction.get("member.invited")).toMatchObject({
      actorUserId: owner,
      details: { invitee: "bob@example.invalid", role: "editor" },
    });
    // The person who joined is the actor, not the person who invited them —
    // `actorUserId` records who did the thing.
    expect(byAction.get("member.joined")).toMatchObject({
      actorUserId: bob,
      details: { role: "editor", invitedBy: owner },
    });

    // Never the token.
    expect(JSON.stringify(events)).not.toContain(token);
  });
});
