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

import { afterEach, beforeEach, expect } from "vitest";
import { convexTest } from "convex-test";
import { v } from "convex/values";
import { api } from "../../_generated/api";
import { internalMutation } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { randomOpaqueToken } from "../../functions/lib/gatewayAuth";
import { hashToken } from "../../functions/lib/crypto";
import { MAGIC_LINK_PROVIDER_ID } from "@supa-media/convex/auth";
import {
  asUser,
  createUser,
  createWorkspace,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";

/** Mirrors SIGNIN_CODE_BYTES in functions/invitationEmail.ts, which is not exported. */
export const SIGNIN_CODE_BYTES = 32;
/**
 * The same constant the module under test uses, imported rather than mirrored.
 * A hand-copied id that quietly stopped matching would not fail — it would make
 * every "the row is under the link-only provider" assertion vacuous instead.
 */
export const SIGNIN_PROVIDER = MAGIC_LINK_PROVIDER_ID;
/** Mirrors RECIPIENT_MAIL_LIMIT. */
export const RECIPIENT_MAIL_LIMIT = 10;

/**
 * The invitation module's own source, read the way `structure.test.ts` reads
 * every module: the "scheduled, not called" property is a property of the
 * *text*, and no runtime assertion can tell the two apart after the fact.
 */
export const INVITATIONS_SOURCE = (
  import.meta.glob("../../functions/invitations.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>
)["../../functions/invitations.ts"];

/** Obviously fake. This repository is public and no real key may appear in it. */
export const FAKE_RESEND_KEY = "re_not_a_real_key_000000000000";
export const FROM_ADDRESS = "invitations@context.invalid";

export interface CapturedSend {
  url: string;
  authorization: string | null;
  body: Record<string, string>;
}

export let captured: CapturedSend[] = [];
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
export let logged: Array<Record<string, unknown>> = [];

export function linesFor(reason: string): Array<Record<string, unknown>> {
  return logged.filter((line) => line.reason === reason);
}

/**
 * How the sender behaves when `fetch` never gets an answer.
 *
 * A rejection, not a 5xx — the two are different facts and, until this suite
 * grew, only one of them was handled.
 */
export function fetchThatNeverArrives(): void {
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
export const mintingAuthStore = internalMutation({
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
export const brokenAuthStore = internalMutation({
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
export function withEnv(values: Record<string, string>): () => void {
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

export const unregisteredAuthStore = internalMutation({
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
export function setupTestWithAuthStore(store: unknown): TestConvex {
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
export async function scenario(t: TestConvex = setupTest()) {
  const inviter = await createUser(t, "ada@example.invalid");
  await createWorkspace(t, inviter, "ada", { displayName: "Ada's Context" });
  await t.run((ctx) => ctx.db.patch(inviter, { name: "Ada Lovelace" }));
  const workspaceId = await createWorkspace(t, inviter, "atlas-team", {
    kind: "shared",
    displayName: "Atlas Team",
  });
  return { t, inviter, workspaceId };
}

export async function invite(
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
export async function queuedSends(t: TestConvex): Promise<number> {
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return jobs.filter((job) => job.name.includes("sendInvitationEmail")).length;
}

/** The one invitation row for a workspace. */
export async function invitationRow(t: TestConvex, workspaceId: Id<"workspaces">) {
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
export function linkFrom(send: CapturedSend): URL {
  const match = /https:\/\/[^\s"<]+\/invite\/[^\s"<]+/.exec(send.body.text);
  if (match === null) throw new Error("no invitation link in the email body");
  expect(send.body.html).toContain(match[0]);
  return new URL(match[0]);
}

