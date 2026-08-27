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
import { convexTest } from "convex-test";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { SIGNIN_CODE_TTL_MS, signInCodeExpiry } from "../functions/lib/invitationEmail";
import { randomOpaqueToken } from "../functions/lib/gatewayAuth";
import { hashToken } from "../functions/lib/crypto";
import { MAGIC_LINK_PROVIDER_ID } from "@supa-media/convex/auth";

/** Mirrors SIGNIN_CODE_BYTES in functions/invitationEmail.ts, which is not exported. */
const SIGNIN_CODE_BYTES = 32;
/**
 * The same constant the module under test uses, imported rather than mirrored.
 * A hand-copied id that quietly stopped matching would not fail — it would make
 * every "the row is under the link-only provider" assertion vacuous instead.
 */
const SIGNIN_PROVIDER = MAGIC_LINK_PROVIDER_ID;
/** Mirrors RECIPIENT_MAIL_LIMIT. */
const RECIPIENT_MAIL_LIMIT = 10;
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
let realOrigin: string | undefined;
let realLog: typeof console.log;

/**
 * The operator-facing log lines this module emits.
 *
 * Captured rather than eyeballed, because several of the properties below are
 * *only* observable there: whether a deployment misconfiguration was refused
 * before or after the invitation was spent, and — the whole point of the
 * `detail` field — whether a mint failure was the expected one.
 */
let logged: Array<Record<string, unknown>> = [];

function linesFor(reason: string): Array<Record<string, unknown>> {
  return logged.filter((line) => line.reason === reason);
}

/**
 * How the sender behaves when `fetch` never gets an answer.
 *
 * A rejection, not a 5xx — the two are different facts and, until this suite
 * grew, only one of them was handled.
 */
function fetchThatNeverArrives(): void {
  globalThis.fetch = (async () => {
    throw new TypeError("network error");
  }) as typeof globalThis.fetch;
}

/* -------------------------------------------------------------------------- */
/* A deployment whose auth config *does* register the link-only provider       */
/* -------------------------------------------------------------------------- */

/**
 * A stand-in for `auth:store` that mints successfully.
 *
 * The reason this exists is written out in the block comment on
 * `SIGNIN_PROVIDER`: the real provider is upstream and unreleased, so on this
 * deployment the mint always throws and the three "degrades to a plain link"
 * tests below assert an absence. An absence is not a tripwire — the day the
 * framework release lands, a mint that silently produced no `?code=` would keep
 * every one of them green. So the post-release state is driven here instead, by
 * substituting the one function the mint calls.
 *
 * It is a faithful-enough copy of `createVerificationCodeImpl`: upsert the user
 * and the account for the address, delete any previous code on that account,
 * and store `sha256(code)` rather than the code. Everything this suite asserts
 * about the result — a `?code=` in the mail, exactly one row, the row not
 * containing the code — is a property of that shape rather than of the copy.
 */
const mintingAuthStore = internalMutation({
  args: { args: v.any() },
  returns: v.null(),
  handler: async (ctx, { args }) => {
    const email = String(args.email);
    const provider = String(args.provider);

    const users = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(1);
    const userId =
      users[0]?._id ??
      (await ctx.db.insert("users", {
        email,
        // Stamped on create, exactly as the framework's `createOrUpdateUser`
        // does — see `accountLinking.test.ts`.
        emailVerificationTime: Date.now(),
        createdAt: Date.now(),
      }));

    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", provider).eq("providerAccountId", email),
      )
      .take(1);
    const accountId =
      accounts[0]?._id ??
      (await ctx.db.insert("authAccounts", {
        userId,
        provider,
        providerAccountId: email,
        emailVerified: email,
      }));

    const previous = await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", accountId))
      .collect();
    for (const row of previous) await ctx.db.delete(row._id);

    await ctx.db.insert("authVerificationCodes", {
      accountId,
      provider,
      code: await hashToken(String(args.code)),
      expirationTime: Number(args.expirationTime),
      emailVerified: email,
    });
    return null;
  },
});

/**
 * A mint that fails for a reason that is *not* "the provider is not registered".
 *
 * The discriminator this suite asserts exists so an operator can tell those two
 * apart; a test that only ever saw one of them would prove nothing.
 */
const brokenAuthStore = internalMutation({
  args: { args: v.any() },
  returns: v.null(),
  handler: async () => {
    throw new Error("expirationTime is not a valid timestamp");
  },
});

/**
 * A deployment whose `auth.ts` does not register the link-only provider.
 *
 * This was the shipping state until `@supa-media/convex@1.2.0`, and it is now
 * the regression: drop `magicLink` from `createSupaAuth` and every invitation
 * quietly goes back to a plain link. The message is the one
 * `getProviderOrThrow` raises for an id nothing declares, spelled through
 * `SIGNIN_PROVIDER` so it cannot drift from the marker
 * `classifyMintFailure` matches on.
 */
/**
 * Set environment variables for one call and put them back exactly.
 *
 * `signIn` needs a signing key and an origin that nothing else in this suite
 * does. Restoring rather than assigning matters because these tests share a
 * process: a leaked `JWT_PRIVATE_KEY` would let a later test mint a session it
 * has no business minting and pass for the wrong reason.
 */
function withEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, was] of previous) {
      if (was === undefined) delete process.env[key];
      else process.env[key] = was;
    }
  };
}

const unregisteredAuthStore = internalMutation({
  args: { args: v.any() },
  returns: v.null(),
  handler: async () => {
    throw new Error(`Provider \`${SIGNIN_PROVIDER}\` is not configured`);
  },
});

/**
 * The whole control plane, with `auth:store` swapped for one of the above.
 *
 * Only that one export is replaced — `auth`, `signIn` and the rest are the real
 * module's — and only inside the instance this returns, so no other test in the
 * repository (`accountLinking.test.ts` in particular, which drives the *real*
 * `auth:store`) sees a substituted one.
 */
function setupTestWithAuthStore(store: unknown): TestConvex {
  const real = modules["./auth.ts"];
  if (real === undefined) throw new Error("auth.ts is not in the module map");
  return convexTest(schema, {
    ...modules,
    "./auth.ts": async () => ({ ...((await real()) as object), store }),
  }) as TestConvex;
}

/**
 * Stand in for Resend.
 *
 * A stub rather than a live call for the obvious reason, and for a
 * less-obvious one: what this suite asserts is the *content* of the request,
 * which is exactly what a network call would hide.
 */
beforeEach(() => {
  captured = [];
  logged = [];
  realKey = process.env.RESEND_API_KEY;
  realOrigin = process.env.APP_ORIGIN;
  process.env.RESEND_API_KEY = FAKE_RESEND_KEY;
  realLog = console.log;
  console.log = ((...parts: unknown[]) => {
    const first = parts[0];
    if (typeof first === "string" && first.includes('"invitation-email"')) {
      logged.push(JSON.parse(first) as Record<string, unknown>);
      return;
    }
    realLog(...parts);
  }) as typeof console.log;
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
  console.log = realLog;
  if (realKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = realKey;
  if (realOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = realOrigin;
});

/**
 * An inviter with a display name, a handle (`@ada`, the slug of her own
 * personal context), and a shared context to invite people into.
 */
async function scenario(t: TestConvex = setupTest()) {
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
