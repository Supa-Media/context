/**
 * SENDING AN INVITATION.
 *
 * `inviteMember` used to write a row and stop, and the only way an invitation
 * reached anybody was `listMyInvitations` — which requires already having an
 * account, already being signed in, and already knowing to look. This suite
 * covers the half that changes that, and the whole of it is about keeping the
 * new behaviour from becoming the oracle the module is shaped to prevent.
 *
 * Four properties, and they are not interchangeable:
 *
 *  1. **The send is scheduled, never called.** `ctx.scheduler.runAfter` enqueues
 *     a job in a separate transaction whose return value the scheduler
 *     discards. Nothing about whether the address exists, whether Resend
 *     accepted it, or how long it took can reach the inviter — see CLAUDE.md,
 *     "Scheduling is not calling". A synchronous send would put all three in
 *     the mutation's own latency.
 *  2. **A `@name` invitee gets nothing.** We do not know their address, and
 *     resolving one would be the enumeration leak `inviteMember` exists to
 *     avoid.
 *  3. **The email is a function of five facts.** Inviter, context, link,
 *     expiry — and nothing about what is inside the context or about who the
 *     recipient is. The bodies for a stranger and for an established account
 *     are compared byte for byte with the link removed.
 *  4. **The magic link is not the invitation token.** The token stays what it
 *     always was — not a bearer credential. Signing in uses a separate,
 *     single-use, 24-hour `authVerificationCodes` row, stored hashed, and it is
 *     minted only for an address with no established context behind it.
 */

/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { SIGNIN_CODE_TTL_MS, signInCodeExpiry } from "../functions/lib/invitationEmail";
import { randomOpaqueToken } from "../functions/lib/gatewayAuth";

/** Mirrors SIGNIN_CODE_BYTES in functions/invitationEmail.ts, which is not exported. */
const SIGNIN_CODE_BYTES = 32;
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  drainScheduled,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

/**
 * The invitation module's own source, read the way `structure.test.ts` reads
 * every module: the "scheduled, not called" property is a property of the
 * *text*, and no runtime assertion can tell the two apart after the fact.
 */
const INVITATIONS_SOURCE = (
  import.meta.glob("../functions/invitations.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>
)["../functions/invitations.ts"];

/** Obviously fake. This repository is public and no real key may appear in it. */
const FAKE_RESEND_KEY = "re_not_a_real_key_000000000000";
const FROM_ADDRESS = "invitations@context.invalid";

interface CapturedSend {
  url: string;
  authorization: string | null;
  body: Record<string, string>;
}

let captured: CapturedSend[] = [];
let realFetch: typeof globalThis.fetch;
let realKey: string | undefined;

/**
 * Stand in for Resend.
 *
 * A stub rather than a live call for the obvious reason, and for a
 * less-obvious one: what this suite asserts is the *content* of the request,
 * which is exactly what a network call would hide.
 */
beforeEach(() => {
  captured = [];
  realKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = FAKE_RESEND_KEY;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    captured.push({
      url,
      authorization:
        new Headers(init?.headers ?? {}).get("Authorization") ?? null,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(JSON.stringify({ id: "fake-message-id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = realKey;
});

/**
 * An inviter with a display name, a handle (`@ada`, the slug of her own
 * personal context), and a shared context to invite people into.
 */
async function scenario() {
  const t = setupTest();
  const inviter = await createUser(t, "ada@example.invalid");
  await createWorkspace(t, inviter, "ada", { displayName: "Ada's Context" });
  await t.run((ctx) => ctx.db.patch(inviter, { name: "Ada Lovelace" }));
  const workspaceId = await createWorkspace(t, inviter, "atlas-team", {
    kind: "shared",
    displayName: "Atlas Team",
  });
  return { t, inviter, workspaceId };
}

async function invite(
  t: TestConvex,
  inviter: Id<"users">,
  workspaceId: Id<"workspaces">,
  invitee: string,
): Promise<null> {
  return await asUser(t, inviter).mutation(
    api.functions.invitations.inviteMember,
    { workspaceId, invitee, role: "member" },
  );
}

/** Every queued job whose target is the invitation sender. */
async function queuedSends(t: TestConvex): Promise<number> {
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return jobs.filter((job) => job.name.includes("sendInvitationEmail")).length;
}

/** The one invitation row for a workspace. */
async function invitationRow(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", workspaceId).eq("status", "pending"),
      )
      .collect();
    if (rows.length !== 1) throw new Error(`expected 1 invitation, got ${rows.length}`);
    return rows[0];
  });
}

/** The link out of the rendered email — the same string in both alternatives. */
function linkFrom(send: CapturedSend): URL {
  const match = /https:\/\/[^\s"<]+\/invite\/[^\s"<]+/.exec(send.body.text);
  if (match === null) throw new Error("no invitation link in the email body");
  expect(send.body.html).toContain(match[0]);
  return new URL(match[0]);
}

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
   * ## Auto sign-in is minted but not yet redeemable, and that is on purpose
   *
   * The link should sign its recipient in on click. It cannot yet, and the
   * reason is upstream: `@convex-dev/auth`'s `Email()` hardcodes an `authorize`
   * that refuses any verification without a matching `params.email`, so a code
   * minted under the OTP provider is stored and expires correctly and then
   * throws the moment anybody clicks it. The fix is a second, link-only
   * provider — committed to supa-framework, not yet released — so
   * `@supa-media/convex@0.2.0` cannot register one.
   *
   * `SIGNIN_PROVIDER` therefore names a provider this deployment does not
   * have, minting throws, and `sendInvitationEmail` catches it and mails a
   * plain link. **The invitation still arrives and still works**; what the
   * recipient loses is one screen.
   *
   * These tests assert the degraded state deliberately rather than being
   * deleted or skipped, because it is the state that ships. When the framework
   * release lands and `auth.ts` registers the provider, they fail — which is
   * exactly the notification wanted, and the block comment on `SIGNIN_PROVIDER`
   * says what to change. The properties that outlive the blocker — the token's
   * shape and its expiry — are asserted on the pure functions instead, below
   * and in `invitationEmailText.test.ts`, so they are not lost in the meantime.
   */
  test("degrades to a plain link while no link-only provider is registered", async () => {
    const { t, inviter, workspaceId } = await scenario();
    await invite(t, inviter, workspaceId, "newcomer@example.invalid");
    await drainScheduled(t);

    // The mail went out. This is the half that must never regress: failing the
    // send because a convenience could not be minted trades the referral for
    // the shortcut.
    expect(captured).toHaveLength(1);
    const link = linkFrom(captured[0]);
    expect(link.searchParams.get("code")).toBeNull();
    // And the invitation token — the thing the link is actually for — is there.
    const row = await invitationRow(t, workspaceId);
    expect(link.pathname).toContain(row!.token);

    // Nothing half-minted: no orphan row waiting to authenticate somebody.
    const codes = await t.run((ctx) =>
      ctx.db.query("authVerificationCodes").collect(),
    );
    expect(codes).toEqual([]);
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

  test("its expiry is capped at a day and inside the invitation it travels with", () => {
    // The other property that outlives the blocker, asserted on the pure
    // function. A link sits in a mailbox and gets forwarded in a way a typed
    // code does not, so it must not stay live for the invitation's whole week
    // — and it must never outlive the invitation itself, which would leave a
    // credential working after the thing it was minted for had expired.
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
   * **It does not happen yet**, because no code is minted at all: the link-only
   * provider is not registered on this deployment (see "the magic link" above),
   * so the mint throws before `auth:store` is reached. So the assertion below
   * is the *current* truth, and it flips the day the framework release lands —
   * at which point this test fails and the paragraph above becomes the one to
   * assert. That is the notification wanted, not a gap.
   */
  test("no account is invented for the invitee while no code is minted", async () => {
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
    expect(created).toEqual([]);
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
