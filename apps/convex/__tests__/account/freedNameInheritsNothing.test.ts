import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import {
  asUser,
  createUser,
  createWorkspace,
} from "../fixtures.helpers";
import {
  onboardedAccount,
} from "./fixtures.helpers";

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
