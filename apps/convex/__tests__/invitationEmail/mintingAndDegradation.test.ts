import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import {
  drainScheduled,
  setupTest,
} from "../fixtures.helpers";
import {
  captured,
  logged,
  linesFor,
  fetchThatNeverArrives,
  mintingAuthStore,
  brokenAuthStore,
  unregisteredAuthStore,
  setupTestWithAuthStore,
  SIGNIN_PROVIDER,
  scenario,
  invite,
  invitationRow,
  linkFrom,
} from "./fixtures";

describe("what minting a sign-in code does to the users table", () => {
  /**
   * `auth:store` upserts a user and an `authAccounts` row for an address it has
   * not seen, and the framework's `createOrUpdateUser` stamps
   * `emailVerificationTime` when it does. That is a side effect worth pinning
   * rather than discovering: inviting a stranger by email would create an
   * account for them, marked verified, before anyone clicked anything.
   *
   * It grants nothing on its own — the row owns no context, holds no session,
   * claims no name, and is reachable only by somebody who can read that
   * mailbox — and it is the same thing typing an address into the sign-in form
   * already does. When the real person signs in later they land on that row and
   * their invitation is waiting, which is the behaviour you want.
   *
   * This is the paragraph the previous version of this test said would become
   * the one to assert. It has: the provider registers, the mint reaches
   * `auth:store`, and the row appears. What is asserted is not just that it
   * exists but that it is *inert* — because "an account was created for
   * somebody who has not clicked anything" is only acceptable while that
   * remains true.
   */
  test("an account appears for the invitee, and it owns nothing", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    // The mail went out, so this is not passing by the send having failed.
    expect(captured).toHaveLength(1);

    const created = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "newcomer@example.invalid"))
        .collect(),
    );
    expect(created).toHaveLength(1);

    // Inert, and that is the whole justification for creating it early. It
    // owns no context, holds no session, and claims no name; the only thing
    // that reaches it is whoever can read that mailbox.
    const userId = created[0]._id;
    const owned = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(owned).toEqual([]);
    // Not vacuous: the same query against the inviter returns rows, so an
    // empty result for the invitee means "no memberships" rather than "this
    // query never matches anything".
    const inviterOwned = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_user", (q) => q.eq("userId", inviter))
        .collect(),
    );
    expect(inviterOwned.length).toBeGreaterThan(0);

    const sessions = await t.run((ctx) =>
      ctx.db.query("authSessions").collect(),
    );
    expect(sessions).toEqual([]);

    // `names` is non-empty here — the inviter's context claimed one — so this
    // is a real absence rather than an empty table. Compared as ids, not via
    // `String(...)`, which would also have "passed" against `undefined`.
    const names = await t.run((ctx) => ctx.db.query("names").collect());
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => n.userId === userId)).toBe(false);
    expect(names.some((n) => n.claimedBy === userId)).toBe(false);
  });

  test("no account is invented for an address that was never mailed", async () => {
    delete process.env.RESEND_API_KEY;
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    const created = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", "newcomer@example.invalid"))
        .collect(),
    );
    expect(created).toEqual([]);
  });
});

describe("what stops this being a way to mail strangers", () => {
  test("an inviter who has not verified their own address sends nothing", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await t.run((ctx) =>
      ctx.db.patch(inviter, { emailVerificationTime: undefined }),
    );

    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(captured).toEqual([]);
    // Dropped silently: the invitation itself is untouched and still answerable
    // in-app, and the inviter is told nothing either way.
    const row = await invitationRow(t, workspaceId);
    expect(row.status).toBe("pending");
    expect(row.emailSentAt).toBeUndefined();
  });

  test("one invitation row sends at most one email, however often the job runs", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);
    expect(captured).toHaveLength(1);

    const row = await invitationRow(t, workspaceId);
    expect(row.emailSentAt).toBeTypeOf("number");

    // Run the sender again against the same row, exactly as a retry would.
    await t.action(internal.functions.invitationEmail.sendInvitationEmail, {
      invitationId: row._id,
      inviteeKind: "email",
    });
    expect(captured).toHaveLength(1);
  });

  test("a revoked invitation stops being mailable", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    const row = await invitationRow(t, workspaceId);
    await t.run((ctx) => ctx.db.patch(row._id, { status: "revoked" }));

    await drainScheduled(t);
    expect(captured).toEqual([]);
  });

  /**
   * A deployment with no Resend key must not half-send: no code minted, no row
   * marked, nothing logged that carries the link. It is the state every test in
   * this repository that is *not* about email runs in.
   */
  test("an unconfigured deployment writes nothing at all", async () => {
    delete process.env.RESEND_API_KEY;
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(captured).toEqual([]);
    const row = await invitationRow(t, workspaceId);
    expect(row.emailSentAt).toBeUndefined();
    const codes = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    expect(codes).toEqual([]);
  });
});

/* ========================================================================== */
/* Failures that must not spend an invitation                                 */
/* ========================================================================== */

describe("a deployment that cannot build a link", () => {
  /**
   * THE BUG THIS DESCRIBES.
   *
   * `invitationUrlFor` refuses to invent an origin, correctly. It used to be
   * called *after* `claimInvitationEmail` had written `emailSentAt`, so on a
   * deployment with a Resend key and no `APP_ORIGIN` every invitation was
   * marked as mailed, the action threw, and no mail was ever sent — for every
   * invitation, identically, with no resend path to recover any of them.
   *
   * The assertion that matters is on the **row**, not on the absence of a
   * `fetch`. A test that only checked `captured` would have passed against the
   * broken code, because the broken code did not send either.
   */
  test("no APP_ORIGIN: nothing is sent, and the invitation is not spent", async () => {
    delete process.env.APP_ORIGIN;
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(captured).toEqual([]);
    const row = await invitationRow(t, workspaceId);
    expect(row.emailSentAt).toBeUndefined();
    expect(row.status).toBe("pending");
    expect(linesFor("app_origin_unusable")).toHaveLength(1);
  });

  test("a plaintext origin is refused the same way, and just as cheaply", async () => {
    process.env.APP_ORIGIN = "http://app.context.invalid";
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(captured).toEqual([]);
    expect((await invitationRow(t, workspaceId)).emailSentAt).toBeUndefined();
    expect(linesFor("app_origin_unusable")).toHaveLength(1);
  });

  /**
   * The third way to be unusable, and the one the original code did not have a
   * branch for at all: `new URL("app.context.invalid")` throws, so a hostname
   * pasted into a dashboard without a scheme was a `TypeError` rather than a
   * refusal.
   */
  test("an origin that is not a URL is a refusal, not a TypeError", async () => {
    process.env.APP_ORIGIN = "app.context.invalid";
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(captured).toEqual([]);
    expect((await invitationRow(t, workspaceId)).emailSentAt).toBeUndefined();
    expect(linesFor("app_origin_unusable")).toHaveLength(1);
  });

  /**
   * The point of leaving the row unspent: the invitation is recoverable. An
   * operator sets the variable, somebody invites again, and the mail goes.
   * Under the old behaviour this address could never be mailed again.
   */
  test("and the invitation is still mailable once the variable is set", async () => {
    delete process.env.APP_ORIGIN;
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);
    expect(captured).toEqual([]);

    process.env.APP_ORIGIN = "https://app.context.invalid";
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(captured).toHaveLength(1);
    expect((await invitationRow(t, workspaceId)).emailSentAt).toBeTypeOf("number");
  });
});

describe("a send that never reaches Resend", () => {
  /**
   * `!response.ok` was always an outcome. A *rejected* `fetch` — DNS, TLS, a
   * dropped connection — was not: it escaped the action, from after the claim,
   * contradicting the function's own "never throws for a bad send" and putting
   * a stack trace with the recipient's address in a log.
   */
  test("a transport failure is an outcome, not an exception", async () => {
    const { t, inviter, workspaceId } = await scenario();
    fetchThatNeverArrives();

    // The assertion is that this resolves at all.
    await expect(invite(t, inviter, workspaceId, "newcomer@example.invalid"))
      .resolves.toBeNull();
    await expect(drainScheduled(t)).resolves.toBeUndefined();

    const failures = linesFor("transport_error");
    expect(failures).toHaveLength(1);
    expect(failures[0].event).toBe("send_failed");
    // A different code from `http_error`: our request was rejected is not the
    // same fact as our request never arrived.
    expect(linesFor("http_error")).toEqual([]);
  });

  /**
   * At-most-once is unchanged by the fix. An outage that *might* have delivered
   * is not a licence to send again — see CLAUDE.md.
   */
  test("the invitation is still spent, because at-most-once does not bend", async () => {
    const { t, inviter, workspaceId } = await scenario();
    fetchThatNeverArrives();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect((await invitationRow(t, workspaceId)).emailSentAt).toBeTypeOf("number");
  });

  test("a refusal from Resend is still reported as a status and nothing else", async () => {
    globalThis.fetch = (async () =>
      new Response("that address is on our suppression list", {
        status: 422,
      })) as typeof globalThis.fetch;

    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    const failures = linesFor("http_error");
    expect(failures).toHaveLength(1);
    expect(failures[0].status).toBe(422);
    // The body quotes the address it refused. It must not appear anywhere.
    expect(JSON.stringify(logged)).not.toContain("newcomer@example.invalid");
  });
});

/* ========================================================================== */
/* Why the sign-in code could not be minted                                   */
/* ========================================================================== */

describe("telling the expected degradation from a broken mint", () => {
  /**
   * Before this, both produced a byte-identical `signin_code_unavailable` line,
   * so an operator watching for the framework release could not tell "still
   * waiting on upstream" from "the provider is registered and minting is
   * broken". The catch did not even bind the error.
   *
   * The release landed, so the expected condition is now *no* degradation at
   * all — asserted here against the real `auth:store`, which is the one that
   * would actually stop minting if `auth.ts` lost `magicLink`. The
   * `provider_not_configured` detail is still classified and still tested, by
   * the test below that provokes it, because it is what an operator would see
   * if that happened.
   */
  test("the happy path degrades not at all", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(captured).toHaveLength(1);
    expect(linesFor("signin_code_unavailable")).toEqual([]);
    // "No degradation was logged" is also true of a build that never tried to
    // mint at all, so say what did happen rather than only what did not.
    expect(linkFrom(captured[0]).searchParams.get("code")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  /**
   * The regression this file exists to catch, stated directly: if `auth.ts`
   * stops registering the provider, minting throws with the marker
   * `classifyMintFailure` looks for, and every invitation silently goes back to
   * a plain link. `unregisteredAuthStore` reproduces exactly that failure —
   * the message `getProviderOrThrow` raises for an id nothing declares.
   *
   * On its own this half is close to circular: the stub builds its message
   * from `SIGNIN_PROVIDER` and the matcher builds `PROVIDER_MISSING_MARKER`
   * from the same constant, so the id cannot drift between them — which is the
   * point — but neither would notice if the *library* reworded the sentence
   * around it. The test below is the half that would: it asks the real library,
   * with no stub anywhere, and pins the wording as a literal. Read them as one
   * guard in two parts, and do not delete the second one.
   */
  test("losing the provider is reported as provider_not_configured, not as a defect", async () => {
    const t = setupTestWithAuthStore(unregisteredAuthStore);
    const { inviter, workspaceId } = await scenario(t);
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    const lines = linesFor("signin_code_unavailable");
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).toBe("provider_not_configured");

    // And the invitation still arrives, which is the point of degrading.
    expect(captured).toHaveLength(1);
    expect(linkFrom(captured[0]).searchParams.get("code")).toBeNull();

    // Nothing half-minted: no orphan row left waiting to authenticate
    // somebody. This assertion used to live on the degraded-state test that
    // the release retired, and it is the only place that still makes it.
    const codes = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    expect(codes).toEqual([]);
  });

  /**
   * The guard above is weaker than it looks on its own, and this is the half
   * that fixes it.
   *
   * `classifyMintFailure` recognises the expected condition by matching
   * `@convex-dev/auth`'s prose. `unregisteredAuthStore` reproduces that prose
   * from the same constant the matcher uses — so if the *library* reworded it,
   * the stub and the matcher would agree with each other and disagree with
   * reality, the test would stay green, and a genuinely unregistered provider
   * would start classifying as `mint_threw_Error`: a real defect reported as
   * one, but the expected condition reported as a defect too, which is the
   * exact confusion the discriminator exists to prevent.
   *
   * So this asks the real library, with no stub anywhere, what it actually says
   * about a provider nothing declares.
   */
  test("the library still says what classifyMintFailure matches on", async () => {
    const t = setupTest();
    const thrown = await t
      .mutation(internal.auth.store, {
        args: {
          type: "createVerificationCode",
          provider: "no-such-provider",
          email: "newcomer@example.invalid",
          code: "irrelevant",
          expirationTime: Date.now() + 60_000,
          allowExtraProviders: false,
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(Error);
    // The marker `classifyMintFailure` builds, for the id it was asked about.
    expect((thrown as Error).message).toContain(
      "Provider `no-such-provider` is not configured",
    );
  });

  test("a mint that breaks for another reason does not claim to be it", async () => {
    const t = setupTestWithAuthStore(brokenAuthStore);
    const { inviter, workspaceId } = await scenario(t);
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    const lines = linesFor("signin_code_unavailable");
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).not.toBe("provider_not_configured");
    expect(String(lines[0].detail)).toMatch(/^mint_threw_[A-Za-z0-9_]+$/);

    // Degradation is unchanged: the invitation is the thing that must arrive.
    expect(captured).toHaveLength(1);
    expect(linkFrom(captured[0]).searchParams.get("code")).toBeNull();
  });

  /**
   * Whatever an error contributes to a log line, it is never its message.
   * Resend's and the auth library's messages both quote things this module
   * spends its length keeping out of logs.
   */
  test("no failure ever puts a message in the log", async () => {
    const t = setupTestWithAuthStore(brokenAuthStore);
    const { inviter, workspaceId } = await scenario(t);
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    const whole = JSON.stringify(logged);
    expect(whole).not.toContain("expirationTime is not a valid timestamp");
    expect(whole).not.toContain("newcomer@example.invalid");
    expect(whole).not.toContain(" ");
  });

  test("a working mint logs no degradation at all", async () => {
    const t = setupTestWithAuthStore(mintingAuthStore);
    const { inviter, workspaceId } = await scenario(t);
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    expect(linesFor("signin_code_unavailable")).toEqual([]);
  });
});

/* ========================================================================== */
/* The state after the framework release                                      */
/* ========================================================================== */

