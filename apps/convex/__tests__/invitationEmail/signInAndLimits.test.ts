import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  drainScheduled,
  type TestConvex,
} from "../fixtures.helpers";
import { SIGNIN_CODE_TTL_MS } from "../../functions/lib/invitationEmail";
import { hashToken } from "../../functions/lib/crypto";
import {
  captured,
  mintingAuthStore,
  setupTestWithAuthStore,
  SIGNIN_PROVIDER,
  RECIPIENT_MAIL_LIMIT,
  scenario,
  invite,
  invitationRow,
  linkFrom,
} from "./fixtures.helpers";

describe("the magic link, once a provider can mint one", () => {
  /**
   * THE POSITIVE TEST.
   *
   * The three "degrades to a plain link" tests assert an absence, which is the
   * right thing to assert about the state that ships and is worth nothing as a
   * regression guard: if the release landed and the mint quietly produced no
   * `?code=`, every one of them would stay green. This drives the whole path —
   * claim, mint, render, send — against a `auth:store` that mints, and asserts
   * the link that comes out of it.
   */
  test("the mail carries the code, and the stored row carries only its hash", async () => {
    const t = setupTestWithAuthStore(mintingAuthStore);
    const { inviter, workspaceId } = await scenario(t);
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(captured).toHaveLength(1);
    const link = linkFrom(captured[0]);
    const code = link.searchParams.get("code");
    expect(code).toMatch(/^[0-9a-f]{64}$/);

    // The invitation token still addresses the invitation, in the path, and is
    // emphatically not the thing that signs anybody in.
    const row = await invitationRow(t, workspaceId);
    expect(link.pathname).toBe(`/invite/${row.token}`);
    expect(code).not.toBe(row.token);

    // Exactly one verification row, holding the digest rather than the code.
    const codes = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    expect(codes).toHaveLength(1);
    expect(codes[0].provider).toBe(SIGNIN_PROVIDER);
    expect(codes[0].code).toBe(await hashToken(code!));
    expect(codes[0].code).not.toBe(code);
  });

  test("its expiry is inside SIGNIN_CODE_TTL_MS and inside the invitation, on the wire", async () => {
    const t = setupTestWithAuthStore(mintingAuthStore);
    const { inviter, workspaceId } = await scenario(t);
    const before = Date.now();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);
    const after = Date.now();

    const row = await invitationRow(t, workspaceId);
    const codes = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    // Bracketed rather than equated: the mint happens somewhere between these
    // two clock readings, and pinning it to either would be a flaky test about
    // scheduling rather than a real one about the cap.
    expect(codes[0].expirationTime).toBeGreaterThan(before);
    expect(codes[0].expirationTime).toBeLessThanOrEqual(
      after + SIGNIN_CODE_TTL_MS,
    );
    // The cap that matters, which #57 set to the invitation's own week.
    expect(codes[0].expirationTime - before).toBeLessThanOrEqual(
      SIGNIN_CODE_TTL_MS + (after - before),
    );
    expect(codes[0].expirationTime).toBeLessThan(row.expiresAt);
  });
});

/* ========================================================================== */
/* Who is allowed a link that signs them in                                   */
/* ========================================================================== */

describe("who gets a link that signs them in", () => {
  /**
   * THE RESIDUAL, ASSERTED AS IT IS RATHER THAN AS IT SHOULD BE.
   *
   * The eligibility lookup below is byte-exact, because `users.by_email` is.
   * `parseInvitee` lowercases every invitee and nothing on the sign-in side
   * used to — so an account stored as `Mixed@Example.invalid` is invisible
   * here, reads as a stranger, and gets mailed an auto-sign-in link into a
   * *second* account that the mint then creates. That is the outcome this
   * whole block exists to prevent, reached by spelling rather than by role.
   *
   * `normalizeSignInEmail` (apps/mobile) closes the only path in the product
   * that creates such a row, so no new ones appear. It cannot fix rows that
   * already exist, and it cannot stop a caller reaching `signIn` directly. The
   * durable fix is normalizing in `createSupaAuth`'s `createOrUpdateUser`,
   * which is upstream and filed separately.
   *
   * So this asserts the gap deliberately, in the same spirit as the
   * degraded-link tests it sits beside: **when the upstream fix lands this
   * test fails**, and that failure is the notification that the residual is
   * gone and the assertion should become its opposite.
   */
  test("a mixed-case account is not recognised — the known residual", async () => {
    const t = setupTestWithAuthStore(mintingAuthStore);
    const { inviter, workspaceId } = await scenario(t);

    // Established by every measure the rule cares about, and stored with a
    // capital letter, which is all it takes.
    const mixed = await createUser(t, "Mixed@Example.invalid");
    await createWorkspace(t, mixed, "mixed-context");

    await invite(t, inviter, workspaceId, "Mixed@Example.invalid");
    await drainScheduled(t);

    // Were the lookup case-insensitive this would be `null`, exactly as it is
    // for Grace below.
    expect(linkFrom(captured[0]).searchParams.get("code")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  test("a stranger with no account does", async () => {
    const t = setupTestWithAuthStore(mintingAuthStore);
    const { inviter, workspaceId } = await scenario(t);
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(linkFrom(captured[0]).searchParams.get("code")).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * THE SET THIS USED TO GET WRONG.
   *
   * The rule, in both docstrings and in CLAUDE.md, is about *established*
   * accounts: a standing credential in a stranger's empty mailbox is not a
   * standing credential into somebody's existing context. The check asked a
   * narrower question — "do they own a personal context" — and Grace here
   * passes it while being about as established as it gets: an `editor` on
   * somebody else's context, with write access to it.
   *
   * The reachable version: `listMembers` gives every member of a context the
   * addresses of the others, so a co-member takes one, makes a throwaway
   * workspace, invites it, and Context mails that person a 24-hour
   * auto-sign-in link into their own account that nobody asked for.
   */
  test("somebody who is only an editor of another context does not", async () => {
    const t = setupTestWithAuthStore(mintingAuthStore);
    const { inviter, workspaceId } = await scenario(t);

    const grace = await createUser(t, "grace@example.invalid");
    const other = await createWorkspace(t, inviter, "other-team", {
      kind: "shared",
    });
    await addMember(t, other, grace, "editor", inviter);
    // The thing the old check looked for, and she has none of it.
    const owned = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_user", (q) => q.eq("userId", grace))
        .collect(),
    );
    expect(owned.every((m) => m.role !== "owner")).toBe(true);

    await invite(t, inviter, workspaceId, "grace@example.invalid");
    await drainScheduled(t);

    expect(captured).toHaveLength(1);
    expect(linkFrom(captured[0]).searchParams.get("code")).toBeNull();
    const codes = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    expect(codes).toEqual([]);
  });

  test("somebody who owns only a shared context does not either", async () => {
    const t = setupTestWithAuthStore(mintingAuthStore);
    const { inviter, workspaceId } = await scenario(t);

    const hopper = await createUser(t, "hopper@example.invalid");
    await createWorkspace(t, hopper, "hopper-team", { kind: "shared" });

    await invite(t, inviter, workspaceId, "hopper@example.invalid");
    await drainScheduled(t);

    expect(linkFrom(captured[0]).searchParams.get("code")).toBeNull();
  });

  /**
   * An account with no memberships still mints, and that is not an oversight.
   * `auth:store` upserts a `users` row the first time a code is minted for an
   * address, so refusing on "an account exists" would make the second
   * invitation to the same never-registered stranger silently degrade.
   */
  test("an account minting created, holding nothing, still does", async () => {
    const t = setupTestWithAuthStore(mintingAuthStore);
    const { inviter, workspaceId } = await scenario(t);

    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);
    const account = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "newcomer@example.invalid"))
        .collect(),
    );
    expect(account).toHaveLength(1);

    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);
    expect(captured).toHaveLength(2);
    expect(linkFrom(captured[1]).searchParams.get("code")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

/* ========================================================================== */
/* Answering an invitation retires the credential it mailed                   */
/* ========================================================================== */

describe("answering an invitation retires the credential it mailed", () => {
  /** An invitation, mailed, with a live sign-in code sitting in an inbox. */
  async function mailedWithACode() {
    const t = setupTestWithAuthStore(mintingAuthStore);
    const { inviter, workspaceId } = await scenario(t);
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);
    const row = await invitationRow(t, workspaceId);
    const codes = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    expect(codes).toHaveLength(1);
    return { t, inviter, workspaceId, row };
  }

  async function liveCodes(t: TestConvex): Promise<number> {
    const codes = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    return codes.length;
  }

  /**
   * Withdrawing an invitation withdrew the offer and left the credential. An
   * owner who clicks "revoke" believes they revoked the access, and for up to
   * 24 hours they had not.
   */
  test("revoking deletes it", async () => {
    const { t, inviter, row } = await mailedWithACode();
    await asUser(t, inviter).mutation(
      api.functions.invitations.revokeInvitation,
      { invitationId: row._id },
    );
    expect(await liveCodes(t)).toBe(0);
  });

  test("declining deletes it", async () => {
    const { t, row } = await mailedWithACode();
    const invitee = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "newcomer@example.invalid"))
        .unique(),
    );
    await asUser(t, invitee!._id).mutation(
      api.functions.invitations.declineInvitation,
      { token: row.token },
    );
    expect(await liveCodes(t)).toBe(0);
  });

  test("accepting deletes it", async () => {
    const { t, row } = await mailedWithACode();
    const invitee = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "newcomer@example.invalid"))
        .unique(),
    );
    await asUser(t, invitee!._id).mutation(
      api.functions.invitations.acceptInvitation,
      { token: row.token },
    );
    expect(await liveCodes(t)).toBe(0);
  });

  /**
   * The interactive OTP is a different provider on a different account row.
   * Somebody halfway through an ordinary sign-in must not have their code
   * deleted by an unrelated invitation being answered.
   */
  test("and leaves an ordinary sign-in code alone", async () => {
    const { t, inviter, row } = await mailedWithACode();
    const otp = await t.run(async (ctx) => {
      const account = await ctx.db.insert("authAccounts", {
        userId: inviter,
        provider: "email",
        providerAccountId: "newcomer@example.invalid",
      });
      return await ctx.db.insert("authVerificationCodes", {
        accountId: account,
        provider: "email",
        code: "f".repeat(64),
        expirationTime: Date.now() + 600_000,
      });
    });

    await asUser(t, inviter).mutation(
      api.functions.invitations.revokeInvitation,
      { invitationId: row._id },
    );

    const left = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    expect(left.map((c) => c._id)).toEqual([otp]);
  });
});

/* ========================================================================== */
/* How much mail one address can be made to receive                           */
/* ========================================================================== */

describe("how much mail one address can be made to receive", () => {
  /**
   * "One send per invitation row, ever" was written as a fence and is not one.
   * `inviteMember` supersedes the row for a `(workspace, invitee)` and clears
   * `emailSentAt` **on purpose** — otherwise re-inviting somebody would be a
   * no-op in their inbox — so pressing invite again is a resend, and neither
   * `MAX_PENDING_INVITATIONS` nor the per-row field binds it.
   *
   * This asserts the reality rather than the claim, so that anybody who reads
   * the docstring and expects otherwise finds out here.
   */
  test("re-inviting genuinely does mail again", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(captured).toHaveLength(2);
    // One row throughout — supersession, not a second invitation.
    const rows = await t.run((ctx) =>
      ctx.db.query("workspaceInvitations").collect(),
    );
    expect(rows).toHaveLength(1);
  });

  /**
   * THE BOUND THAT ACTUALLY HOLDS.
   *
   * What the workspace `displayName` buys an attacker is up to 80 chosen
   * characters in the Subject line of mail from our own domain with a genuine
   * app link under it — escaped correctly, so this is deliverability and
   * sending reputation rather than confidentiality, and those are exactly what
   * a mail bomb costs. `INVITE_LIMIT` bounds the *sender* at 20 an hour and
   * accounts are free, so before this the recipient was unbounded.
   */
  test("but only so many times, and the limit is the recipient's", async () => {
    const { t, inviter, workspaceId } = await scenario();
    for (let i = 0; i < RECIPIENT_MAIL_LIMIT + 3; i += 1) {
      await invite(t, inviter, workspaceId, "newcomer@example.invalid");
      await drainScheduled(t);
    }

    expect(captured).toHaveLength(RECIPIENT_MAIL_LIMIT);
    // The refused offers are unspent rather than half-sent.
    expect((await invitationRow(t, workspaceId)).emailSentAt).toBeUndefined();
  });

  /**
   * The four ways round the per-row field are a second offer, a second
   * inviter, a second workspace and a second account. The limiter is keyed on
   * the recipient, so none of them buys any budget.
   */
  test("a second workspace and a second inviter do not reset it", async () => {
    const { t, inviter, workspaceId } = await scenario();
    for (let i = 0; i < RECIPIENT_MAIL_LIMIT; i += 1) {
      await invite(t, inviter, workspaceId, "newcomer@example.invalid");
      await drainScheduled(t);
    }
    expect(captured).toHaveLength(RECIPIENT_MAIL_LIMIT);

    const mallory = await createUser(t, "mallory@example.invalid");
    const throwaway = await createWorkspace(t, mallory, "throwaway", {
      kind: "shared",
      displayName: "READ THIS NOW - urgent account notice",
    });
    await invite(t, mallory, throwaway, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(captured).toHaveLength(RECIPIENT_MAIL_LIMIT);
  });

  /**
   * A refusal must not reach the inviter. The limiter is consumed inside the
   * scheduled action for exactly this reason: an error whose presence depended
   * on how much mail *other people* had sent that address would be a
   * cross-tenant oracle in the invite box.
   */
  test("and being over it is invisible to whoever is inviting", async () => {
    const { t, inviter, workspaceId } = await scenario();
    for (let i = 0; i < RECIPIENT_MAIL_LIMIT; i += 1) {
      await invite(t, inviter, workspaceId, "newcomer@example.invalid");
      await drainScheduled(t);
    }

    const mallory = await createUser(t, "mallory@example.invalid");
    const throwaway = await createWorkspace(t, mallory, "throwaway", {
      kind: "shared",
    });
    await expect(
      invite(t, mallory, throwaway, "newcomer@example.invalid"),
    ).resolves.toBeNull();
    // And the invitation itself is unaffected — it is answerable in-app, which
    // is the channel that must work whatever mail does.
    const mine = await t.run((ctx) =>
      ctx.db
        .query("workspaceInvitations")
        .withIndex("by_workspace_status", (q) =>
          q.eq("workspaceId", throwaway).eq("status", "pending"),
        )
        .collect(),
    );
    expect(mine).toHaveLength(1);
  });

  /**
   * A deployment misconfiguration must not become a way to spend somebody
   * else's mail budget. The origin check returns before the claim, so it
   * consumes nothing — and, equally, it reaches no network, so it is not a
   * second way to send.
   */
  test("an unusable origin costs the recipient none of their budget", async () => {
    delete process.env.APP_ORIGIN;
    const { t, inviter, workspaceId } = await scenario();
    for (let i = 0; i < RECIPIENT_MAIL_LIMIT + 5; i += 1) {
      await invite(t, inviter, workspaceId, "newcomer@example.invalid");
      await drainScheduled(t);
    }
    expect(captured).toEqual([]);

    process.env.APP_ORIGIN = "https://app.context.invalid";
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);
    expect(captured).toHaveLength(1);
  });
});
