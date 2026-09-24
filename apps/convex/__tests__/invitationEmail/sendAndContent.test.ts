import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  drainScheduled,
} from "../fixtures.helpers";
import { SIGNIN_CODE_TTL_MS, signInCodeExpiry } from "../../functions/lib/invitationEmail";
import { hashToken } from "../../functions/lib/crypto";
import { randomOpaqueToken } from "../../functions/lib/gatewayAuth";
import {
  INVITATIONS_SOURCE,
  FAKE_RESEND_KEY,
  FROM_ADDRESS,
  captured,
  mintingAuthStore,
  withEnv,
  SIGNIN_CODE_BYTES,
  SIGNIN_PROVIDER,
  scenario,
  invite,
  queuedSends,
  invitationRow,
  linkFrom,
} from "./fixtures.helpers";

describe("the send is scheduled, and only for an address", () => {
  test("an email invitee queues exactly one send", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");

    expect(await queuedSends(t)).toBe(1);
    await drainScheduled(t);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://api.resend.com/emails");
    expect(captured[0].authorization).toBe(`Bearer ${FAKE_RESEND_KEY}`);
    expect(captured[0].body.from).toBe(FROM_ADDRESS);
    expect(captured[0].body.to).toBe("newcomer@example.invalid");
  });

  test("a @name invitee queues nothing, because we have no address for them", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "@somebody-else");

    expect(await queuedSends(t)).toBe(0);
    await drainScheduled(t);
    expect(captured).toEqual([]);
  });

  /**
   * The second half of the same rule, asserted on its own.
   *
   * `inviteMember` declines to schedule for a handle, and `claimInvitationEmail`
   * declines to act on one — two checks, because the cost is a branch and the
   * failure mode is mailing somebody we were never given an address for. Only
   * the first is observable through the public mutation, so the second is
   * driven directly: a handle row, handed to the sender with the kind lied
   * about, still produces nothing.
   */
  test("the sender refuses a handle even when told it is an address", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "@somebody-else");
    const row = await invitationRow(t, workspaceId);
    expect(row.inviteeKind).toBe("name");

    await t.action(internal.functions.invitationEmail.sendInvitationEmail, {
      invitationId: row._id,
      inviteeKind: "email",
    });

    expect(captured).toEqual([]);
    const after = await invitationRow(t, workspaceId);
    expect(after.emailSentAt).toBeUndefined();
  });

  /**
   * The sender is scheduled, and the graph must be able to see that it is —
   * `__tests__/structure.test.ts` says a scheduled target has to be a
   * statically resolvable `internal.` reference, and a `ctx.runAction` here
   * would be a call, with a return value, in the inviter's own transaction.
   */
  test("inviteMember schedules the sender rather than calling it", () => {
    const source = INVITATIONS_SOURCE;
    expect(source).toMatch(
      /scheduler\.runAfter\(\s*0,\s*internal\.functions\.invitationEmail\.sendInvitationEmail/,
    );
    expect(source).not.toMatch(/runAction\([^)]*invitationEmail/);
    expect(source).not.toMatch(/runMutation\([^)]*invitationEmail/);
  });

  /**
   * THE ORACLE PROPERTY.
   *
   * The inviter must not be able to tell an address that will be emailed from
   * a handle that will not — not from the return value, and not from anything
   * else the call hands back.
   */
  test("inviteMember returns the same nothing either way", async () => {
    const { t, inviter, workspaceId } = await scenario();
    const forAnAddress = await invite(
      t,
      inviter,
      workspaceId,
      "newcomer@example.invalid",
    );
    const forAHandle = await invite(t, inviter, workspaceId, "@somebody-else");

    expect(forAnAddress).toBeNull();
    expect(forAHandle).toBeNull();
    expect(JSON.stringify(forAnAddress)).toBe(JSON.stringify(forAHandle));

    // And what the inviter can read afterwards is the same shape for both.
    const listed = await asUser(t, inviter).query(
      api.functions.invitations.listInvitations,
      { workspaceId },
    );
    expect(listed.map((row) => row.invitee).sort()).toEqual([
      "@somebody-else",
      "newcomer@example.invalid",
    ]);
    for (const row of listed) {
      expect(Object.keys(row).sort()).toEqual([
        "createdAt",
        "expiresAt",
        "invitedBy",
        "invitee",
        "invitationId",
        "role",
      ].sort());
    }
  });
});

describe("what the email is allowed to say", () => {
  test("names the inviter and the context", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    const send = captured[0];
    expect(send.body.subject).toContain("Ada Lovelace (@ada)");
    expect(send.body.subject).toContain("Atlas Team");
    expect(send.body.text).toContain("Ada Lovelace (@ada)");
    expect(send.body.text).toContain("Atlas Team");
    expect(send.body.html).toContain("Ada Lovelace (@ada)");
    expect(send.body.html).toContain("Atlas Team");
  });

  test("says nothing about the contents of the context or who else is in it", async () => {
    const { t, inviter, workspaceId } = await scenario();
    const grace = await createUser(t, "grace@example.invalid");
    await t.run((ctx) => ctx.db.patch(grace, { name: "Grace Hopper" }));
    await addMember(t, workspaceId, grace, "editor", inviter);

    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    const send = captured[0];
    const whole = `${send.body.subject}\n${send.body.text}\n${send.body.html}`.toLowerCase();
    for (const forbidden of [
      "grace",
      "grace@example.invalid",
      "0-inbox",
      "1-projects",
      "2-areas",
      "3-resources",
      "4-archive",
      "privacy.md",
      "note",
      "folder",
      "member",
      "editor",
      "already",
      "account",
    ]) {
      expect(whole, `the email body mentions "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
  });

  /**
   * The strongest form of "does not say whether you have an account": render
   * both, delete the link, and compare the bytes. Only the link may differ.
   */
  test("reads identically to a stranger and to somebody who already has a context", async () => {
    const { t, inviter, workspaceId } = await scenario();
    const bob = await createUser(t, "bob@example.invalid");
    await createWorkspace(t, bob, "bob-context");

    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await invite(t, inviter, workspaceId, "bob@example.invalid");
    await drainScheduled(t);
    expect(captured).toHaveLength(2);

    const withoutLinks = captured.map((send) => {
      const link = linkFrom(send).toString();
      return [send.body.subject, send.body.text, send.body.html]
        .map((part) => part.split(link).join("<LINK>"))
        .join("\n---\n");
    });
    expect(withoutLinks[0]).toBe(withoutLinks[1]);
  });

  test("the invitation token itself is never asked to be a password", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    const row = await invitationRow(t, workspaceId);
    const link = linkFrom(captured[0]);
    // The token addresses the invitation, in the path, exactly as before.
    expect(link.pathname).toBe(`/invite/${row.token}`);
    // The thing that signs anybody in is a different secret entirely.
    expect(link.searchParams.get("code")).not.toBe(row.token);
  });
});

describe("the magic link", () => {
  /**
   * ## Auto sign-in works, against the real provider
   *
   * These three tests used to assert the opposite. `@convex-dev/auth`'s
   * `Email()` hardcodes an `authorize` that refuses any verification without a
   * matching `params.email` — right for a code typed off a screen, fatal for a
   * link whose whole premise is that the URL carries everything. The fix is a
   * second, link-only provider, which lived upstream unreleased, so
   * `@supa-media/convex@0.2.0` could not register one: the mint threw, the send
   * caught it, and a plain link went out. That degraded state was asserted
   * deliberately, as the state that shipped, and designed to fail the day the
   * provider appeared.
   *
   * It did. `@supa-media/convex@1.2.0` exports `MAGIC_LINK_PROVIDER_ID` and
   * `auth.ts` passes `magicLink`, so this is now the real path and these assert
   * it end to end — claim, mint, render, send — against the deployment's own
   * `auth:store` rather than a substitute. The stubbed `mintingAuthStore` tests
   * further down are kept: they prove the same shape while isolating the send
   * from auth's storage, which is what makes a failure in either one legible.
   */
  test("carries a sign-in code, minted under the link-only provider", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    // The mail went out. This is the half that must never regress: failing the
    // send because a convenience could not be minted trades the referral for
    // the shortcut.
    expect(captured).toHaveLength(1);
    const link = linkFrom(captured[0]);
    const code = link.searchParams.get("code");
    expect(code).toMatch(/^[0-9a-f]{64}$/);

    // And the invitation token — the thing the link is actually for — is still
    // in the path, and is emphatically not the secret that signs anybody in.
    const row = await invitationRow(t, workspaceId);
    expect(link.pathname).toContain(row!.token);
    expect(code).not.toBe(row!.token);

    // Exactly one verification row, under the link-only provider, holding the
    // digest rather than the code. Under `"email"` the link would be inert.
    const codes = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    expect(codes).toHaveLength(1);
    expect(codes[0].provider).toBe(SIGNIN_PROVIDER);
    expect(codes[0].code).toBe(await hashToken(code!));
    expect(codes[0].code).not.toBe(code);
  });

  /**
   * THE TEST THIS WHOLE PROVIDER EXISTS FOR, and the one everything above
   * stops short of.
   *
   * Every other assertion here ends at "a row exists with the right provider
   * on it". None of them redeems anything — and the bug the second provider
   * was created to fix does not live in the row. It lives in `authorize`,
   * cleared by a post-spread override in `@supa-media/convex`'s `setup.ts`
   * that its own comment concedes is the kind of thing a refactor drops
   * silently. If that override stopped taking effect, every assertion above
   * stays green while every link in every invitation throws on click.
   *
   * So this clicks the link: the code out of the mail, submitted with **no
   * email**, which is the whole premise of a link and precisely what the OTP
   * provider refuses. It asserts a real session for a real user, which needs a
   * signing key — generated here rather than fixtured, so nothing shaped like
   * a credential is committed to a public repository.
   */
  test("the code in the mail signs its holder in, with no email supplied", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);
    const code = linkFrom(captured[0]).searchParams.get("code");
    expect(code).toMatch(/^[0-9a-f]{64}$/);

    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const restore = withEnv({
      JWT_PRIVATE_KEY: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      SITE_URL: "https://context.invalid",
      CONVEX_SITE_URL: "https://context.invalid",
    });

    try {
      const result = await t.action(api.auth.signIn, {
        provider: SIGNIN_PROVIDER,
        params: { code },
      });
      expect(result.tokens).not.toBeNull();
      expect(typeof result.tokens!.token).toBe("string");
    } finally {
      restore();
    }

    // A session exists, and it belongs to the invitee rather than the inviter.
    const invitee = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "newcomer@example.invalid"))
        .unique(),
    );
    expect(invitee).not.toBeNull();
    const sessions = await t.run((ctx) =>
      ctx.db.query("authSessions").collect(),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userId).toBe(invitee!._id);
    expect(sessions[0].userId).not.toBe(inviter);

    // Single use: the row is spent, so the same link cannot be replayed.
    const left = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    expect(left).toEqual([]);
  });

  /**
   * `auth.ts` sets `magicLink.maxAge` to an hour, and the link lives for the
   * invitation's seven days. Both are true at once, and the reason is not
   * obvious enough to leave to a reading: `maxAge` is consulted only where the
   * *library* generates a code (`signIn.js`), while redemption checks the
   * stored row (`verifyCodeAndSignIn.js`). This module mints its own code and
   * passes its own `expirationTime`, so `maxAge` never touches it.
   *
   * Without this test, someone "aligning" `maxAge` with SIGNIN_CODE_TTL_MS —
   * or shortening the link by editing `maxAge` — would be changing a value
   * that does nothing here, and would believe they had changed the link.
   *
   * Asserting only the invitation's own expiry would not show that, because
   * it restates SIGNIN_CODE_TTL_MS and would pass with `maxAge` set to
   * anything at all. So this drives **both** paths through the one provider in
   * one test and contrasts them: the invitation, which supplies its own
   * expiry, and the public `signIn(MAGIC_LINK_PROVIDER_ID, { email })`, which
   * is the path `maxAge` really does bound. Two orders of magnitude apart is
   * the observable difference, and it is what disappears if either half stops
   * being true.
   */
  test("maxAge bounds the public signIn mint, and the invitation's own expiry bounds the link", async () => {
    const { t, inviter, workspaceId } = await scenario();
    const before = Date.now();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);
    // Bracketed against the post-send reading, not the pre-send one: the mint
    // happens somewhere between the two, so `before + TTL` is not an upper
    // bound at all and fails by a millisecond whenever the send is not
    // instantaneous.
    const after = Date.now();

    const codes = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    expect(codes).toHaveLength(1);
    expect(codes[0].provider).toBe(SIGNIN_PROVIDER);
    // Well past the hour `magicLink.maxAge` would have imposed had it applied.
    expect(codes[0].expirationTime).toBeGreaterThan(before + 60 * 60 * 1000);
    expect(codes[0].expirationTime).toBeLessThanOrEqual(
      after + SIGNIN_CODE_TTL_MS,
    );

    // The same provider, reached the other way. No invitation, no expiry
    // supplied by us — so this one is the library's own, and `maxAge` is what
    // sets it. If `maxAge` were seven days, this assertion is what would fail.
    //
    // `signIn` builds a redirect against SITE_URL, which nothing else in this
    // suite needs; set for this call and put back, so no other test inherits it.
    const restoreEnv = withEnv({
      SITE_URL: "https://context.invalid",
      CONVEX_SITE_URL: "https://context.invalid",
    });
    const mintedAt = Date.now();
    try {
      await t.action(api.auth.signIn, {
        provider: SIGNIN_PROVIDER,
        params: { email: "stranger@example.invalid" },
      });
    } finally {
      restoreEnv();
    }
    const strangerCode = await t.run(async (ctx) => {
      const all = await ctx.db.query("authVerificationCodes").collect();
      return all.find((row) => row.expirationTime !== codes[0].expirationTime);
    });
    expect(strangerCode).toBeDefined();
    expect(strangerCode!.expirationTime).toBeLessThanOrEqual(
      Date.now() + 60 * 60 * 1000,
    );
    expect(strangerCode!.expirationTime).toBeGreaterThan(mintedAt);
    // And emphatically not the invitation's week.
    expect(strangerCode!.expirationTime).toBeLessThan(
      mintedAt + SIGNIN_CODE_TTL_MS,
    );
  });

  test("the token it would carry is not guessable, and is not a six-digit code", () => {
    // Asserted on the generator rather than through the send, so the entropy
    // requirement survives the blocker above. It matters more here than for an
    // OTP: the link-only provider has no email check and no rate limit, so the
    // token is the only secret between a guess and a session.
    const minted = randomOpaqueToken(SIGNIN_CODE_BYTES);
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.length).toBeGreaterThanOrEqual(32);
  });

  /**
   * A magic link is a credential sitting in an inbox. Addressed to a brand-new
   * account with nothing in it, that is the referral path working as intended;
   * addressed to somebody's established context, the blast radius is a
   * different thing entirely. They get the plain invitation link and the
   * ordinary sign-in screen.
   */
  test("carries no code for somebody who already owns a personal context", async () => {
    const { t, inviter, workspaceId } = await scenario();
    const bob = await createUser(t, "bob@example.invalid");
    await createWorkspace(t, bob, "bob-context");

    await invite(t, inviter, workspaceId, "bob@example.invalid");
    await drainScheduled(t);

    const link = linkFrom(captured[0]);
    expect(link.searchParams.get("code")).toBeNull();
    expect(link.search).toBe("");
    const codes = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    expect(codes).toEqual([]);
  });

  test("its expiry is capped at SIGNIN_CODE_TTL_MS and inside the invitation it travels with", () => {
    // Asserted on the pure function rather than through a send, so the cap is
    // proved independently of how the code gets minted. #57 made the cap the
    // invitation's own seven days — single use, not the clock, is what bounds
    // the link — so what remains load-bearing is the second half: the code must
    // never outlive the invitation itself, which would leave a credential
    // working after the thing it was minted for had expired.
    const now = Date.UTC(2026, 0, 1);
    const invitationExpiry = now + 7 * 24 * 60 * 60 * 1000;
    const expiry = signInCodeExpiry(now, invitationExpiry);
    expect(expiry).not.toBeNull();
    expect(expiry!).toBeLessThanOrEqual(now + SIGNIN_CODE_TTL_MS);
    expect(expiry!).toBeLessThan(invitationExpiry);

    // An invitation already inside its last day drags the code down with it.
    const nearlyExpired = now + 60 * 1000;
    const clamped = signInCodeExpiry(now, nearlyExpired);
    expect(clamped!).toBeLessThan(nearlyExpired);
  });
});

