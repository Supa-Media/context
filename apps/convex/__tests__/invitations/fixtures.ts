/**
 * INVITATIONS.
 *
 * Two properties are being proved here, and they pull in different directions,
 * which is why they need separate assertions:
 *
 *  1. **An invitation is a capability.** Single-use, expiring, unguessable —
 *     and, on top of all three, bound to the person it was addressed to.
 *     Accepting one you were not sent must fail exactly like accepting one that
 *     never existed.
 *
 *  2. **An invitation is not an existence oracle.** The attacker here is the
 *     *inviter*: anybody with an account has an invite box, so if the outcome
 *     of inviting `@nobody` differed in any observable way from inviting a real
 *     person — or from inviting somebody who already turned them down — the box
 *     would enumerate the platform's names. Several tests below therefore
 *     compare whole responses, not just "both succeeded".
 *
 * If you are changing `functions/invitations.ts` and one of these breaks, the
 * endpoint is wrong. Do not adjust the assertion.
 */

import type { Id } from "../../_generated/dataModel";
import {
  createUser,
  createWorkspace,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";

/** Serialize a thrown error's payload so two failures can be compared exactly. */
export function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

/**
 * An owner with a shared context, and three other people:
 *
 *  - `bob` owns `@bob-context`, so `@bob-context` addresses him.
 *  - `carol` owns `@carol-context`.
 *  - `mallory` owns a context of her own, so she is a legitimate authenticated
 *    user rather than an anonymous caller — the realistic attacker.
 */
export async function shared() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");
  const carol = await createUser(t, "carol@example.invalid");
  const mallory = await createUser(t, "mallory@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "team-context", {
    kind: "shared",
    displayName: "Team Context",
  });
  await createWorkspace(t, bob, "bob-context");
  await createWorkspace(t, carol, "carol-context");
  await createWorkspace(t, mallory, "mallory-context");

  return { t, owner, bob, carol, mallory, workspaceId };
}

/** A syntactically valid invitation id that refers to nothing. */
export async function danglingInvitationId(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  invitedBy: Id<"users">,
): Promise<Id<"workspaceInvitations">> {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("workspaceInvitations", {
      workspaceId,
      inviteeKind: "name",
      invitee: "temporary-placeholder",
      role: "member",
      invitedBy,
      token: "temporary-placeholder-token",
      status: "pending",
      expiresAt: Date.now() + 1000,
      createdAt: Date.now(),
    });
    await ctx.db.delete(id);
    return id;
  });
}

/** Age an invitation past its expiry without touching the clock. */
export async function expire(t: TestConvex, token: string): Promise<void> {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (row === null) throw new Error("no such invitation");
    await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
  });
}

