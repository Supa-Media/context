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

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { formatInvitee, parseInvitee } from "../functions/lib/invitees";
// The mobile half of a two-package invariant — see the test that uses it.
import { normalizeSignInEmail } from "../../mobile/features/auth/email";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  pendingInvitationToken,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

/** Serialize a thrown error's payload so two failures can be compared exactly. */
function errorShape(error: unknown): string {
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
async function shared() {
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
async function danglingInvitationId(
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
async function expire(t: TestConvex, token: string): Promise<void> {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (row === null) throw new Error("no such invitation");
    await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
  });
}

describe("parsing an invitee", () => {
  test("a handle is accepted with or without the sigil, and normalized", () => {
    for (const raw of ["@lk", "lk", "  @LK  ", "LK"]) {
      expect(parseInvitee(raw)).toEqual({
        ok: true,
        invitee: { kind: "name", value: "lk" },
      });
    }
  });

  test("an address is accepted and lowercased", () => {
    expect(parseInvitee("  LK@Example.Invalid ")).toEqual({
      ok: true,
      invitee: { kind: "email", value: "lk@example.invalid" },
    });
  });

  /**
   * The invariant that spans two packages, asserted rather than claimed.
   *
   * `apps/mobile/__tests__/signInEmail.test.ts` states it in its own header —
   * *"the address handed to `signIn` must be the same string an invitation to
   * them would have been addressed to. `parseInvitee` … trims and lowercases;
   * so does this"* — and then imports only the mobile side and asserts its own
   * literals. This file asserts its own literals too. **Both halves were
   * pinned, and neither was pinned to the other**, which is the shape
   * `CLAUDE.md` names when it insists the consent-scope mirror be "asserted
   * against the control plane's rather than claimed in a comment".
   *
   * **The repair landed, and it changes what this test is for.** Both sides
   * now call `normalizeEmail` from `packages/shared`, so over the domain
   * `parseInvitee` accepts they agree *by construction* rather than by two
   * chains happening to match. The mirror in `signInEmail.test.ts` is gone with
   * its table — two identical fixture tables in two packages, pinned to their
   * own literals and not to each other, were the sentence this test exists to
   * fix, one level up, and they had already drifted inside their own commits.
   *
   * **What is left here is a DIVERGENCE detector, which is not the same as a
   * duplication detector.** No behavioural test can see a behaviourally
   * identical copy, on either side: re-inlining `raw.trim().toLowerCase()` into
   * `normalizeSignInEmail` left every check green until an identity assertion
   * was added there, and re-inlining `trimmed.toLowerCase()` into
   * `parseInvitee` left **every check in both suites** green — this table
   * included, because it compares two functions that still return the same
   * string. That half is now held by
   * `__tests__/sharedEmailRule.test.ts`, which asserts the *call*.
   *
   * What this table catches is the moment such a copy *drifts* — dropping the
   * lowercase fails 3 here and 4 in `apps/mobile` — and any asymmetric change
   * to the shared rule itself, where dropping the trim fails 3 here. It also
   * covers the control plane's own drift, which nothing in `apps/mobile` can
   * any longer see: `const value = trimmed` fails 6 here and 0 there. This is
   * the copy CI depends on: `gateway-contracts.yml` carries no `paths` filter
   * and runs this whole suite on every pull request **into `main`**, so a
   * mobile-only change reaches it where `ci / Test Convex Backend` would skip.
   * (`branches: [main]` filters on the base, so a pull request stacked onto a
   * feature branch runs neither this nor `ci.yml`; nothing covers the pair
   * there.) `packages/shared/**` is additionally in **both** the `mobile` and
   * `convex` change filters of the reusable pipeline — read at source in
   * `supa-framework/.github/workflows/ci.yml`, not assumed — so a change to the
   * shared rule itself runs both suites.
   *
   * The convex suite already reaches into the mobile app (see
   * `dropboxConnect.test.ts`), so the import costs nothing new — and it has to
   * be the mobile function rather than the shared one, or the test proves only
   * that `packages/shared` agrees with itself.
   *
   * **What is asserted is still narrower than the invariant named above.** The
   * guard below means the table only covers addresses `parseInvitee`
   * *accepts*. Outside that domain the two genuinely diverge: `parseInvitee`
   * refuses an over-length or pattern-failing address that
   * `normalizeSignInEmail` normalises without complaint, because the sign-in
   * screen applies no such rule. That asymmetry is real, is recorded
   * separately, and was deliberately not papered over by widening
   * `normalizeEmail`'s job.
   *
   * The failure it prevents: one human ends up with two accounts and the
   * invitation lands on the one they cannot sign in to.
   */
  test.each([
    "LK@Example.Invalid",
    "  lk@example.invalid  ",
    "MiXeD.CaSe+tag@Example.Invalid",
    "\tada@example.invalid\n",
    "ALLCAPS@EXAMPLE.INVALID",
  ])("the sign-in normalizer agrees with the invitee parser on %j", (raw) => {
    const parsed = parseInvitee(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.invitee.kind !== "email") throw new Error("fixture is not an email");
    expect(normalizeSignInEmail(raw)).toBe(parsed.invitee.value);
  });

  test("the sigil is positional, so a handle can never be read as an address", () => {
    // An `@` anywhere but the front means "mailbox", and `@lk@x.invalid` is
    // therefore a malformed address rather than a handle called `lk@x.invalid`.
    expect(parseInvitee("@lk@x.invalid")).toEqual({
      ok: false,
      reason: "invalid_email",
    });
  });

  test("rejects what is neither", () => {
    expect(parseInvitee("")).toEqual({ ok: false, reason: "empty" });
    expect(parseInvitee("   ")).toEqual({ ok: false, reason: "empty" });
    expect(parseInvitee("no spaces here")).toEqual({
      ok: false,
      reason: { name: "invalid_characters" },
    });
    expect(parseInvitee("not@an@address")).toEqual({
      ok: false,
      reason: "invalid_email",
    });
    expect(parseInvitee("lk@localhost")).toEqual({
      ok: false,
      reason: "invalid_email",
    });
    // Only one sigil is stripped, and the second `@` is not at position 0, so
    // this lands in the address branch and fails there. Either way it is
    // rejected — what matters is that it lands in exactly one branch.
    expect(parseInvitee("@@lk")).toEqual({ ok: false, reason: "invalid_email" });
  });

  test("formats back to what a person typed", () => {
    expect(formatInvitee({ kind: "name", value: "lk" })).toBe("@lk");
    expect(formatInvitee({ kind: "email", value: "lk@example.invalid" })).toBe(
      "lk@example.invalid",
    );
  });
});

describe("only an owner may invite", () => {
  test("a member cannot, and an editor cannot either", async () => {
    const { t, owner, bob, carol, workspaceId } = await shared();
    await addMember(t, workspaceId, bob, "editor", owner);
    await addMember(t, workspaceId, carol, "member", owner);

    for (const [userId, role] of [
      [bob, "editor"],
      [carol, "member"],
    ] as const) {
      const error = await captureError(() =>
        asUser(t, userId).mutation(api.functions.invitations.inviteMember, {
          workspaceId,
          invitee: "@somebody-else",
          role: "member",
        }),
      );
      expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
      expect(
        (error as { data: { actualRole: string } }).data.actualRole,
      ).toBe(role);
    }

    const invitations = await asUser(t, owner).query(
      api.functions.invitations.listInvitations,
      { workspaceId },
    );
    expect(invitations).toEqual([]);
  });

  test("a stranger is told the context does not exist, identically to one that never did", async () => {
    const { t, mallory, workspaceId } = await shared();
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
      asUser(t, mallory).mutation(api.functions.invitations.inviteMember, {
        workspaceId,
        invitee: "@somebody",
        role: "member",
      }),
    );
    const nonexistent = await captureError(() =>
      asUser(t, mallory).mutation(api.functions.invitations.inviteMember, {
        workspaceId: dangling,
        invitee: "@somebody",
        role: "member",
      }),
    );

    expect(errorCode(foreign)).toBe("WORKSPACE_NOT_FOUND");
    expect(errorShape(foreign)).toBe(errorShape(nonexistent));
  });

  test("an invitation can never confer ownership", async () => {
    const { t, owner, workspaceId } = await shared();
    // Rejected by the argument validator, not by a handler check somebody could
    // relax. `owner` is not in the union at all.
    await expect(
      asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
        workspaceId,
        invitee: "@bob-context",
        // @ts-expect-error — the point of the test is that this is not a role.
        role: "owner",
      }),
    ).rejects.toThrow();

    expect(
      await asUser(t, owner).query(api.functions.invitations.listInvitations, {
        workspaceId,
      }),
    ).toEqual([]);
  });
});

describe("the whole flow", () => {
  test("invited by address, delivered, accepted, and a member appears", async () => {
    const { t, owner, bob, workspaceId } = await shared();

    const returned = await asUser(t, owner).mutation(
      api.functions.invitations.inviteMember,
      { workspaceId, invitee: "bob@example.invalid", role: "editor" },
    );
    expect(returned).toBeNull();

    const pending = await asUser(t, owner).query(
      api.functions.invitations.listInvitations,
      { workspaceId },
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      invitee: "bob@example.invalid",
      role: "editor",
      invitedBy: owner,
    });

    const mine = await asUser(t, bob).query(
      api.functions.invitations.listMyInvitations,
      {},
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      workspaceId,
      slug: "team-context",
      displayName: "Team Context",
      role: "editor",
    });

    const joined = await asUser(t, bob).mutation(
      api.functions.invitations.acceptInvitation,
      { token: mine[0].token },
    );
    expect(joined).toMatchObject({ workspaceId, slug: "team-context", role: "editor" });

    const members = await asUser(t, bob).query(
      api.functions.workspaces.listMembers,
      { workspaceId },
    );
    expect(members.map((m) => [m.email, m.role])).toEqual([
      ["owner@example.invalid", "owner"],
      ["bob@example.invalid", "editor"],
    ]);

    // The offer is spent, so it leaves the pending list.
    expect(
      await asUser(t, owner).query(api.functions.invitations.listInvitations, {
        workspaceId,
      }),
    ).toEqual([]);
    expect(
      await asUser(t, bob).query(api.functions.invitations.listMyInvitations, {}),
    ).toEqual([]);
  });

  test("a handle addresses the person whose personal context it names", async () => {
    const { t, owner, bob, workspaceId } = await shared();

    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });

    const token = await pendingInvitationToken(t, bob, workspaceId);
    expect(token).not.toBeNull();
    await asUser(t, bob).mutation(api.functions.invitations.acceptInvitation, {
      token: token as string,
    });

    const members = await asUser(t, owner).query(
      api.functions.workspaces.listMembers,
      { workspaceId },
    );
    expect(members.find((m) => m.userId === bob)?.role).toBe("member");
  });

  test("a handle that names a shared context addresses nobody", async () => {
    const { t, owner, carol, workspaceId } = await shared();
    // `@other-team` is a context, not a person. Inviting a context into a
    // context is a mount, which is deliberately not built — so the invitation
    // is created (no oracle) and is simply unanswerable.
    await createWorkspace(t, carol, "other-team", { kind: "shared" });

    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@other-team",
      role: "editor",
    });

    expect(
      await asUser(t, owner).query(api.functions.invitations.listInvitations, {
        workspaceId,
      }),
    ).toHaveLength(1);
    expect(
      await asUser(t, carol).query(api.functions.invitations.listMyInvitations, {}),
    ).toEqual([]);
  });

  test("an unverified address addresses nobody either", async () => {
    const { t, owner, workspaceId } = await shared();
    const unverified = await t.run((ctx) =>
      ctx.db.insert("users", {
        email: "unverified@example.invalid",
        createdAt: Date.now(),
      }),
    );

    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "unverified@example.invalid",
      role: "member",
    });

    // The row exists — the inviter is told nothing — but an address nobody has
    // proved they hold cannot be used to walk into a context.
    expect(
      await asUser(t, owner).query(api.functions.invitations.listInvitations, {
        workspaceId,
      }),
    ).toHaveLength(1);
    expect(
      await asUser(t, unverified).query(
        api.functions.invitations.listMyInvitations,
        {},
      ),
    ).toEqual([]);
  });
});

describe("an invitation is not an existence oracle", () => {
  test("inviting a name nobody holds is indistinguishable from inviting one somebody does", async () => {
    const { t, owner, workspaceId } = await shared();

    const real = await asUser(t, owner).mutation(
      api.functions.invitations.inviteMember,
      { workspaceId, invitee: "@bob-context", role: "member" },
    );
    const imaginary = await asUser(t, owner).mutation(
      api.functions.invitations.inviteMember,
      { workspaceId, invitee: "@nobody-is-called-this", role: "member" },
    );
    expect(real).toBeNull();
    expect(imaginary).toBeNull();

    // ...and the rows they produced differ only in the identifier that was
    // typed. Anything else here — a resolved user id, a "delivered" flag, a
    // different ordering — would answer "is @bob-context real?".
    const pending = await asUser(t, owner).query(
      api.functions.invitations.listInvitations,
      { workspaceId },
    );
    expect(pending).toHaveLength(2);
    const scrub = (row: Record<string, unknown>) =>
      JSON.stringify({ ...row, invitationId: null, invitee: null, createdAt: null, expiresAt: null });
    expect(scrub(pending[0])).toBe(scrub(pending[1]));
  });

  test("somebody who declined looks exactly like somebody who never existed", async () => {
    const { t, owner, bob, workspaceId } = await shared();

    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const token = await pendingInvitationToken(t, bob, workspaceId);
    await asUser(t, bob).mutation(api.functions.invitations.declineInvitation, {
      token: token as string,
    });

    // A decline is invisible. Not "shown as declined" — absent, exactly as if
    // the invitation had been ignored, or had been sent to nobody at all.
    expect(
      await asUser(t, owner).query(api.functions.invitations.listInvitations, {
        workspaceId,
      }),
    ).toEqual([]);

    // Re-invite the person who said no, and invite a name nobody holds. One
    // pending row each, identical but for the identifier: there is nowhere for
    // "this one already turned you down" to show.
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@nobody-is-called-this",
      role: "member",
    });

    const pending = await asUser(t, owner).query(
      api.functions.invitations.listInvitations,
      { workspaceId },
    );
    expect(pending).toHaveLength(2);
    const scrub = (row: Record<string, unknown>) =>
      JSON.stringify({ ...row, invitationId: null, invitee: null, createdAt: null, expiresAt: null });
    expect(scrub(pending[0])).toBe(scrub(pending[1]));
  });

  test("a decline leaves no audit trail for the inviter to read", async () => {
    const { t, owner, bob, workspaceId } = await shared();

    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "member",
    });
    const token = await pendingInvitationToken(t, bob, workspaceId);
    await asUser(t, bob).mutation(api.functions.invitations.declineInvitation, {
      token: token as string,
    });

    const events = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    // The invitation being sent is recorded — the owner's own act, and already
    // in `listInvitations`. The answer is not: an `invitation.declined` row
    // would tell every member that `@bob-context` is a real person who read it.
    expect(events.map((e) => e.action)).toEqual(["member.invited"]);
  });

  test("a rejection is about the string, never about who exists", async () => {
    const { t, owner, workspaceId } = await shared();

    // Both malformed, neither resolvable — and the refusals are produced before
    // anything is looked up, so they cannot differ by who is on the platform.
    const one = await captureError(() =>
      asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
        workspaceId,
        invitee: "not an identifier",
        role: "member",
      }),
    );
    expect(errorCode(one)).toBe("INVALID_INVITEE");

    // A well-formed name nobody holds is accepted, exactly like one somebody
    // does. There is no "no such user" refusal to reach.
    expect(
      await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
        workspaceId,
        invitee: "@nobody-is-called-this",
        role: "member",
      }),
    ).toBeNull();
  });

  test("inviting somebody already in the context does nothing, and does not complain", async () => {
    const { t, owner, bob, workspaceId } = await shared();
    await addMember(t, workspaceId, bob, "editor", owner);

    const returned = await asUser(t, owner).mutation(
      api.functions.invitations.inviteMember,
      { workspaceId, invitee: "@bob-context", role: "member" },
    );
    expect(returned).toBeNull();

    // No row, so nothing to answer; and crucially no demotion — a re-invite as
    // `member` must not quietly downgrade an editor.
    expect(
      await asUser(t, owner).query(api.functions.invitations.listInvitations, {
        workspaceId,
      }),
    ).toEqual([]);
    const members = await asUser(t, owner).query(
      api.functions.workspaces.listMembers,
      { workspaceId },
    );
    expect(members.find((m) => m.userId === bob)?.role).toBe("editor");
  });

  test("no role ever sees an invitation token in the workspace listing", async () => {
    const { t, owner, bob, carol, workspaceId } = await shared();
    await addMember(t, workspaceId, carol, "member", owner);

    await asUser(t, owner).mutation(api.functions.invitations.inviteMember, {
      workspaceId,
      invitee: "@bob-context",
      role: "editor",
    });
    const token = (await pendingInvitationToken(t, bob, workspaceId)) as string;

    for (const userId of [owner, carol]) {
      const serialized = JSON.stringify(
        await asUser(t, userId).query(api.functions.invitations.listInvitations, {
          workspaceId,
        }),
      );
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain("token");
    }
  });
});

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

    const { internal } = await import("../_generated/api");
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
