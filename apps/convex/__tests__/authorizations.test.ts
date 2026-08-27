/**
 * The consent screen, as a security boundary.
 *
 * `functions/authorizations.ts` is the one place a human decides that an AI
 * client may reach their notes. Everything before it is the gateway parking a
 * request; everything after it is a code being spent. If this layer can be
 * confused about *who* is asking or *whose context* is being granted, none of
 * the two-factor machinery downstream matters.
 *
 * What is proved here, in the order it matters:
 *
 *  1. **Nothing is revealed to the wrong caller.** Unauthenticated learns
 *     nothing; a caller with no context of their own learns nothing about the
 *     request; the workspace named on the screen is always one the caller
 *     belongs to, and a slug they do not belong to is not echoed back.
 *  2. **Every dead request looks identical.** Nonexistent, expired, approved,
 *     consumed and denied are one answer on read and one error on write, so a
 *     `requestId` cannot be probed for which guesses landed.
 *  3. **Membership is checked at approval time**, transactionally, against the
 *     workspace actually being granted — including when the caller did not name
 *     one.
 *  4. **Approving someone else's parked request fails**, and arms nothing.
 *  5. **Expiry is enforced on read *and* on approve**, not only on the screen.
 *  6. **Refusal is real**: it redirects with `access_denied` and consumes the
 *     request, so the same screen cannot be answered twice.
 *  7. **The screen and the approval agree** about which context is at stake.
 *  8. **The grant records what the person chose**, not what the client asked
 *     for — including the privacy tier — and no request shape lets an approver
 *     hand over more than their own role could.
 *
 * Every token, client and credential here is obviously fake. This repository is
 * public.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  gatewayPost,
  setupTest,
} from "./fixtures.helpers";

const CLIENT_ID = "mcp_client_alpha";
const REDIRECT_URI = "https://client.example/callback";
const SCOPE = "context:read context:write";

/** The PKCE challenge shape the control plane insists on: base64url S256. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier) as BufferSource,
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const VERIFIER = "a".repeat(64);

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text());
}

/**
 * Two people with their own contexts, and a registered client.
 *
 * Both go through the real routes: the client is registered the way the gateway
 * registers it, and requests are parked the way the gateway parks them. A
 * hand-inserted `oauthAuthorizations` row would prove things about a shape no
 * production code produces.
 */
async function twoPeople() {
  const t: TestConvex = setupTest();
  const alice = await createUser(t, "alice@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");

  const aliceWs = await createWorkspace(t, alice, "alpha", {
    displayName: "Alice's Context",
  });
  const bobWs = await createWorkspace(t, bob, "alphabet", {
    displayName: "Bob's Context",
  });

  await gatewayPost(t, "/gateway/clients/register", {
    clientId: CLIENT_ID,
    clientName: "Example AI Client",
    redirectUris: [REDIRECT_URI],
    hashedClientSecret: null,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scope: SCOPE,
    applicationType: "web",
  });

  return { t, alice, bob, aliceWs, bobWs };
}

/** Park a request exactly as `/gateway/authorize/start` does. */
async function park(
  t: TestConvex,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await gatewayPost(t, "/gateway/authorize/start", {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    state: "xyz",
    codeChallenge: await s256(VERIFIER),
    codeChallengeMethod: "S256",
    scope: SCOPE,
    resource: "https://mcp.context.test/mcp",
    requestedWorkspaceSlug: "alpha",
    ...overrides,
  });
  const body = await bodyOf(response);
  if (typeof body.requestId !== "string") {
    throw new Error(`no request parked: ${JSON.stringify(body)}`);
  }
  return body.requestId;
}

function read(t: TestConvex, userId: Id<"users">, requestId: string) {
  return asUser(t, userId).query(
    api.functions.authorizations.getAuthorizationRequest,
    { requestId },
  );
}

function approve(
  t: TestConvex,
  userId: Id<"users">,
  requestId: string,
  workspaceId?: Id<"workspaces">,
) {
  return asUser(t, userId).action(
    api.functions.authorizations.approveAuthorization,
    workspaceId === undefined ? { requestId } : { requestId, workspaceId },
  );
}

function deny(t: TestConvex, userId: Id<"users">, requestId: string) {
  return asUser(t, userId).action(
    api.functions.authorizations.denyAuthorization,
    { requestId },
  );
}

/** Approve while narrowing, the way the consent screen's tick boxes do. */
function approveWith(
  t: TestConvex,
  userId: Id<"users">,
  requestId: string,
  grantedScopes: string[],
  workspaceId?: Id<"workspaces">,
) {
  return asUser(t, userId).action(
    api.functions.authorizations.approveAuthorization,
    workspaceId === undefined
      ? { requestId, grantedScopes }
      : { requestId, workspaceId, grantedScopes },
  );
}

/** What the row records as approved — the field the token exchange reads. */
async function grantedScopeOf(
  t: TestConvex,
  requestId: string,
): Promise<string | undefined> {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("oauthAuthorizations")
      .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
      .unique();
    if (row === null) throw new Error("no such request");
    return row.grantedScope;
  });
}

/** Push a parked request past its window without waiting ten minutes. */
async function expire(t: TestConvex, requestId: string): Promise<void> {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("oauthAuthorizations")
      .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
      .unique();
    if (row === null) throw new Error("no such request");
    await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
  });
}

/* -------------------------------------------------------------------------- */
/* 1. Reading the request                                                     */
/* -------------------------------------------------------------------------- */

describe("the consent screen tells the right person the right thing", () => {
  test("shows who is asking, what they want, and which context is at stake", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    const requestId = await park(t);

    expect(await read(t, alice, requestId)).toEqual({
      requestId,
      clientName: "Example AI Client",
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      scopes: ["context:read", "context:write"],
      requestedWorkspaceSlug: "alpha",
      workspaceId: aliceWs,
      workspaceSlug: "alpha",
      workspaceName: "Alice's Context",
      // Alice owns this context, so the screen may offer her both tiers and
      // every operation the client asked for.
      workspaceRole: "owner",
      grantableScopes: ["context:read", "context:write"],
      grantableTiers: ["team", "private"],
      expiresAt: expect.any(Number),
    });
  });

  test("an unauthenticated caller learns nothing about a request id", async () => {
    const { t } = await twoPeople();
    const requestId = await park(t);

    expect(
      errorCode(
        await captureError(() =>
          t.query(api.functions.authorizations.getAuthorizationRequest, {
            requestId,
          }),
        ),
      ),
    ).toBe("NOT_AUTHENTICATED");
  });

  /**
   * The oracle this ordering exists to close.
   *
   * A caller with no context cannot be shown a consent screen — there is
   * nothing for consent to mean. But the refusal must not depend on whether the
   * request id was real, or "I have no workspace" becomes a way to test
   * `requestId` guesses. So the workspace check runs first, and both a real and
   * a fabricated id produce the byte-identical error.
   */
  test("a caller with no context is refused identically for a real and a fake id", async () => {
    const { t } = await twoPeople();
    const newcomer = await createUser(t, "newcomer@example.invalid");
    const requestId = await park(t);

    const real = await captureError(() => read(t, newcomer, requestId));
    const fake = await captureError(() =>
      read(t, newcomer, "0".repeat(36)),
    );

    expect(errorCode(real)).toBe("NO_GRANTABLE_WORKSPACE");
    expect(JSON.stringify((real as { data: unknown }).data)).toBe(
      JSON.stringify((fake as { data: unknown }).data),
    );
  });

  /**
   * The requested slug is a preselection hint. Echoing it to somebody who
   * cannot be preselected into it tells them which context a client named,
   * which is none of their business.
   */
  test("a slug the caller does not belong to is not echoed back", async () => {
    const { t, bob, bobWs } = await twoPeople();
    // The client asked for Alice's context. Bob is looking at the screen.
    const requestId = await park(t, { requestedWorkspaceSlug: "alpha" });

    const seen = await read(t, bob, requestId);
    expect(seen?.requestedWorkspaceSlug).toBeNull();
    // …and the context on offer is Bob's own, never Alice's.
    expect(seen?.workspaceId).toBe(bobWs);
    expect(seen?.workspaceSlug).toBe("alphabet");
  });

  test("the workspace shown is always one the caller belongs to", async () => {
    const { t, alice, bob, aliceWs, bobWs } = await twoPeople();
    const requestId = await park(t, { requestedWorkspaceSlug: null });

    expect((await read(t, alice, requestId))?.workspaceId).toBe(aliceWs);
    expect((await read(t, bob, requestId))?.workspaceId).toBe(bobWs);
  });

  /** A shared context the requester belongs to is selectable by slug. */
  test("a requested slug wins when the caller really is a member", async () => {
    const { t, alice, bob, bobWs } = await twoPeople();
    await addMember(t, bobWs, alice, "editor", bob);
    const requestId = await park(t, { requestedWorkspaceSlug: "alphabet" });

    const seen = await read(t, alice, requestId);
    expect(seen?.workspaceId).toBe(bobWs);
    expect(seen?.requestedWorkspaceSlug).toBe("alphabet");
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Every dead request looks the same                                       */
/* -------------------------------------------------------------------------- */

describe("a dead request is indistinguishable from one that never existed", () => {
  test("nonexistent, expired, approved, consumed and denied all read as null", async () => {
    const { t, alice, aliceWs } = await twoPeople();

    const nonexistent = await read(t, alice, "0".repeat(36));

    const expired = await park(t);
    await expire(t, expired);

    const approved = await park(t);
    await approve(t, alice, approved, aliceWs);

    const consumed = await park(t);
    const { redirectTo } = await approve(t, alice, consumed, aliceWs);
    await gatewayPost(t, "/gateway/codes/consume", {
      code: new URL(redirectTo).searchParams.get("code"),
      clientId: CLIENT_ID,
    });

    const denied = await park(t);
    await deny(t, alice, denied);

    for (const [label, requestId] of [
      ["expired", expired],
      ["approved", approved],
      ["consumed", consumed],
      ["denied", denied],
    ] as const) {
      expect(await read(t, alice, requestId), `${label} leaked`).toBe(
        nonexistent,
      );
    }
    expect(nonexistent).toBeNull();
  });

  test("approving any of them throws the same error as a fabricated id", async () => {
    const { t, alice, aliceWs } = await twoPeople();

    const fabricated = await captureError(() =>
      approve(t, alice, "0".repeat(36), aliceWs),
    );

    const expired = await park(t);
    await expire(t, expired);

    const approved = await park(t);
    await approve(t, alice, approved, aliceWs);

    const denied = await park(t);
    await deny(t, alice, denied);

    for (const [label, requestId] of [
      ["expired", expired],
      ["already approved", approved],
      ["denied", denied],
    ] as const) {
      const error = await captureError(() => approve(t, alice, requestId, aliceWs));
      expect(errorCode(error), label).toBe("AUTHORIZATION_REQUEST_NOT_FOUND");
      expect(
        JSON.stringify((error as { data: unknown }).data),
        `${label} is distinguishable from a fabricated id`,
      ).toBe(JSON.stringify((fabricated as { data: unknown }).data));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Approval is authorized against the workspace being granted              */
/* -------------------------------------------------------------------------- */

describe("approval requires membership of the context being granted", () => {
  test("approving someone else's parked request into their context fails and arms nothing", async () => {
    const { t, bob, aliceWs } = await twoPeople();
    const requestId = await park(t);

    const error = await captureError(() => approve(t, bob, requestId, aliceWs));
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");

    const row = await t.run((ctx) =>
      ctx.db
        .query("oauthAuthorizations")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .unique(),
    );
    expect(row?.status).toBe("pending");
    expect(row?.hashedCode).toBeUndefined();
    expect(row?.workspaceId).toBeUndefined();
    expect(row?.userId).toBeUndefined();
  });

  /**
   * Membership is re-checked at the moment the code is minted, not when the
   * screen was rendered. Someone removed from a shared context between the two
   * must not be able to complete the grant they were looking at.
   */
  test("membership removed between rendering and approving stops the approval", async () => {
    const { t, alice, bob, bobWs } = await twoPeople();
    await addMember(t, bobWs, alice, "editor", bob);
    const requestId = await park(t, { requestedWorkspaceSlug: "alphabet" });

    // Alice can see it, and it names Bob's shared context.
    expect((await read(t, alice, requestId))?.workspaceId).toBe(bobWs);

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", bobWs).eq("userId", alice),
        )
        .unique();
      if (membership !== null) await ctx.db.delete(membership._id);
    });

    expect(
      errorCode(await captureError(() => approve(t, alice, requestId, bobWs))),
    ).toBe("WORKSPACE_NOT_FOUND");
  });

  /**
   * The resolved path has to be checked too, or "omit the workspace" becomes a
   * way around the membership rule. It cannot be — the resolver only returns
   * contexts the caller belongs to — and this is the test that says so.
   */
  test("approving without naming a workspace grants exactly what the screen showed", async () => {
    const { t, alice, bob, aliceWs, bobWs } = await twoPeople();
    // The client asked for Alice's context; Bob is the one approving.
    const requestId = await park(t, { requestedWorkspaceSlug: "alpha" });

    const shown = await read(t, bob, requestId);
    expect(shown?.workspaceId).toBe(bobWs);

    const { redirectTo } = await approve(t, bob, requestId);
    const consumed = await bodyOf(
      await gatewayPost(t, "/gateway/codes/consume", {
        code: new URL(redirectTo).searchParams.get("code"),
        clientId: CLIENT_ID,
      }),
    );

    const authorization = consumed.authorization as {
      workspaceId: string;
      userId: string;
    };
    // What the screen promised is what the grant carries — and it is emphatically
    // not the context the client named.
    expect(authorization.workspaceId).toBe(bobWs);
    expect(authorization.workspaceId).not.toBe(aliceWs);
    expect(authorization.userId).toBe(bob);
    expect(alice).not.toBe(bob);
  });

  test("a caller with no context cannot approve at all", async () => {
    const { t } = await twoPeople();
    const newcomer = await createUser(t, "newcomer@example.invalid");
    const requestId = await park(t);

    expect(
      errorCode(await captureError(() => approve(t, newcomer, requestId))),
    ).toBe("NO_GRANTABLE_WORKSPACE");

    const row = await t.run((ctx) =>
      ctx.db.query("oauthAuthorizations").unique(),
    );
    expect(row?.status).toBe("pending");
  });

  test("an unauthenticated caller cannot approve", async () => {
    const { t, aliceWs } = await twoPeople();
    const requestId = await park(t);

    expect(
      errorCode(
        await captureError(() =>
          t.action(api.functions.authorizations.approveAuthorization, {
            requestId,
            workspaceId: aliceWs,
          }),
        ),
      ),
    ).toBe("NOT_AUTHENTICATED");
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Expiry, on read and on write                                            */
/* -------------------------------------------------------------------------- */

describe("expiry is enforced on both halves", () => {
  test("an expired request cannot be read", async () => {
    const { t, alice } = await twoPeople();
    const requestId = await park(t);
    expect(await read(t, alice, requestId)).not.toBeNull();

    await expire(t, requestId);
    expect(await read(t, alice, requestId)).toBeNull();
  });

  /**
   * The write check is not the read check. A client calling the action directly
   * never renders a screen, so an approval that trusted the read's expiry
   * enforcement would have no enforcement at all.
   */
  test("an expired request cannot be approved, even without ever reading it", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    const requestId = await park(t);
    await expire(t, requestId);

    expect(
      errorCode(await captureError(() => approve(t, alice, requestId, aliceWs))),
    ).toBe("AUTHORIZATION_REQUEST_NOT_FOUND");
    const row = await t.run((ctx) =>
      ctx.db.query("oauthAuthorizations").unique(),
    );
    expect(row?.status).toBe("pending");
    expect(row?.hashedCode).toBeUndefined();
  });

  test("an expired request cannot be denied either", async () => {
    const { t, alice } = await twoPeople();
    const requestId = await park(t);
    await expire(t, requestId);

    expect(errorCode(await captureError(() => deny(t, alice, requestId)))).toBe(
      "AUTHORIZATION_REQUEST_NOT_FOUND",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Refusal                                                                 */
/* -------------------------------------------------------------------------- */

describe("a person can say no, and no means no", () => {
  test("refusing redirects with access_denied, the client's state, and no code", async () => {
    const { t, alice } = await twoPeople();
    const requestId = await park(t);

    const { redirectTo } = await deny(t, alice, requestId);
    const url = new URL(redirectTo);

    expect(url.origin + url.pathname).toBe(REDIRECT_URI);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.get("code")).toBeNull();
    // A refusal says nothing about the person or their contexts.
    expect(redirectTo).not.toContain("alpha");
  });

  test("refusing consumes the request, so the same screen cannot be answered twice", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    const requestId = await park(t);

    await deny(t, alice, requestId);

    // Not re-presentable…
    expect(await read(t, alice, requestId)).toBeNull();
    // …not deniable again…
    expect(errorCode(await captureError(() => deny(t, alice, requestId)))).toBe(
      "AUTHORIZATION_REQUEST_NOT_FOUND",
    );
    // …and, the one that matters, not approvable afterwards.
    expect(
      errorCode(await captureError(() => approve(t, alice, requestId, aliceWs))),
    ).toBe("AUTHORIZATION_REQUEST_NOT_FOUND");
  });

  test("a refused request mints no code, and none can be redeemed from it", async () => {
    const { t, alice } = await twoPeople();
    const requestId = await park(t);
    await deny(t, alice, requestId);

    const row = await t.run((ctx) =>
      ctx.db.query("oauthAuthorizations").unique(),
    );
    expect(row?.status).toBe("denied");
    expect(row?.hashedCode).toBeUndefined();
    expect(row?.workspaceId).toBeUndefined();
    expect(row?.userId).toBeUndefined();
    expect(row?.deniedAt).toBeTypeOf("number");

    // And there is no grant anywhere as a result.
    expect(await t.run((ctx) => ctx.db.query("oauthGrants").collect())).toEqual(
      [],
    );
  });

  test("an approved request cannot be retroactively denied", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    const requestId = await park(t);
    await approve(t, alice, requestId, aliceWs);

    expect(errorCode(await captureError(() => deny(t, alice, requestId)))).toBe(
      "AUTHORIZATION_REQUEST_NOT_FOUND",
    );
    const row = await t.run((ctx) =>
      ctx.db.query("oauthAuthorizations").unique(),
    );
    expect(row?.status).toBe("approved");
  });

  test("an unauthenticated caller cannot deny", async () => {
    const { t } = await twoPeople();
    const requestId = await park(t);

    expect(
      errorCode(
        await captureError(() =>
          t.action(api.functions.authorizations.denyAuthorization, {
            requestId,
          }),
        ),
      ),
    ).toBe("NOT_AUTHENTICATED");
    expect(
      (await t.run((ctx) => ctx.db.query("oauthAuthorizations").unique()))
        ?.status,
    ).toBe("pending");
  });

  /**
   * Refusal must be available to someone who has not created a context yet —
   * that is precisely the person most likely to want it, and the read they
   * cannot perform must not become a "no" they cannot say.
   */
  test("someone with no context of their own can still refuse", async () => {
    const { t } = await twoPeople();
    const newcomer = await createUser(t, "newcomer@example.invalid");
    const requestId = await park(t);

    const { redirectTo } = await deny(t, newcomer, requestId);
    expect(new URL(redirectTo).searchParams.get("error")).toBe("access_denied");
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The sweep                                                               */
/* -------------------------------------------------------------------------- */

describe("expired authorization rows are swept", () => {
  test("only rows well past their window are deleted", async () => {
    const { t, alice, aliceWs } = await twoPeople();

    const live = await park(t);
    const justExpired = await park(t);
    await expire(t, justExpired);
    const longExpired = await park(t);
    const spent = await park(t);
    await approve(t, alice, spent, aliceWs);

    await t.run(async (ctx) => {
      for (const requestId of [longExpired, spent]) {
        const row = await ctx.db
          .query("oauthAuthorizations")
          .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
          .unique();
        await ctx.db.patch(row!._id, {
          expiresAt: Date.now() - 25 * 60 * 60 * 1000,
        });
      }
    });

    // The cron's target, run directly. Convex does not run crons under test,
    // and asserting on the schedule rather than the behaviour would prove
    // nothing about what actually gets deleted.
    const result = await t.mutation(
      internal.functions.authorizations.purgeExpiredAuthorizations,
      {},
    );
    expect(result).toEqual({ deleted: 2, moreRemaining: false });

    const left = await t.run((ctx) =>
      ctx.db.query("oauthAuthorizations").collect(),
    );
    expect(left.map((row) => row.requestId).sort()).toEqual(
      [live, justExpired].sort(),
    );
  });

  test("a backlog says so, and drains over repeated runs", async () => {
    const { t } = await twoPeople();
    const parked: string[] = [];
    for (let i = 0; i < 3; i += 1) parked.push(await park(t));
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("oauthAuthorizations").collect()) {
        await ctx.db.patch(row._id, {
          expiresAt: Date.now() - 25 * 60 * 60 * 1000,
        });
      }
    });

    const first = await t.mutation(
      internal.functions.authorizations.purgeExpiredAuthorizations,
      { limit: 2 },
    );
    expect(first).toEqual({ deleted: 2, moreRemaining: true });

    const second = await t.mutation(
      internal.functions.authorizations.purgeExpiredAuthorizations,
      { limit: 2 },
    );
    expect(second).toEqual({ deleted: 1, moreRemaining: false });
    expect(
      await t.run((ctx) => ctx.db.query("oauthAuthorizations").collect()),
    ).toEqual([]);
    expect(parked).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/* 7. What the approval actually grants                                       */
/* -------------------------------------------------------------------------- */

/**
 * The consent screen is a convenience; this layer is the authority.
 *
 * Every test here drives `approveAuthorization` directly, with the argument
 * shapes a hostile client would send rather than the ones the screen produces.
 * That is the point: unticking a box in a browser is not a security control,
 * and a narrowing that only the UI performs is a narrowing an attacker skips by
 * calling the action.
 */
describe("an approval grants what the person chose, never what the client asked", () => {
  test("the row records what was approved, and keeps what was asked separately", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    const requestId = await park(t);

    await approveWith(t, alice, requestId, ["context:read"], aliceWs);

    expect(await grantedScopeOf(t, requestId)).toBe("context:read");
    // The request is not rewritten. "Asked for read+write, was given read" is
    // two facts, and an audit trail that keeps only the second cannot show that
    // anybody narrowed anything.
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("oauthAuthorizations")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .unique(),
    );
    expect(row?.scope).toBe(SCOPE);
  });

  test("an owner who says nothing about the tier gets team, not their ceiling", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    const requestId = await park(t);

    await approve(t, alice, requestId, aliceWs);

    // The owner's role has not changed and never will. What changed is that the
    // tier is now something the grant records rather than something the
    // gateway re-derives, and an approval that named no tier named `team`.
    expect(await grantedScopeOf(t, requestId)).toBe("context:read context:write");
  });

  test("an owner who chooses private-tier gets it recorded on the grant", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    const requestId = await park(t);

    await approveWith(
      t,
      alice,
      requestId,
      ["context:read", "context:write", "context:private"],
      aliceWs,
    );

    expect(await grantedScopeOf(t, requestId)).toBe(
      "context:read context:write context:private",
    );
  });

  test("the tier survives a client that never asked for it", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    // The client asked for read only. `context:private` is not an operation the
    // client requests — it is the person answering "how much of my context does
    // this see" — so it is the one scope an approval may add.
    const requestId = await park(t, { scope: "context:read" });

    await approveWith(
      t,
      alice,
      requestId,
      ["context:read", "context:private"],
      aliceWs,
    );

    expect(await grantedScopeOf(t, requestId)).toBe("context:read context:private");
  });

  test("an approval cannot add an operation the client never asked for", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    const requestId = await park(t, { scope: "context:read" });

    await approveWith(
      t,
      alice,
      requestId,
      ["context:read", "context:write", "context:capture"],
      aliceWs,
    );

    expect(await grantedScopeOf(t, requestId)).toBe("context:read");
  });

  test("approving with nothing ticked grants nothing and is refused", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    const requestId = await park(t);

    expect(
      errorCode(
        await captureError(() => approveWith(t, alice, requestId, [], aliceWs)),
      ),
    ).toBe("NO_SCOPES_GRANTED");

    // And the request is still pending: a refused approval must not consume the
    // capability, or a mis-click would strand the flow.
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("oauthAuthorizations")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .unique(),
    );
    expect(row?.status).toBe("pending");
    expect(row?.hashedCode).toBeUndefined();
  });

  test("a tier scope with no operation behind it is refused too", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    const requestId = await park(t);

    // `["context:private"]` would mint a token allowed to reach every private
    // note and with no way to read one. Incoherent, not narrow.
    expect(
      errorCode(
        await captureError(() =>
          approveWith(t, alice, requestId, ["context:private"], aliceWs),
        ),
      ),
    ).toBe("NO_SCOPES_GRANTED");
  });

  test("the audit trail records the request and the grant, and the tier", async () => {
    const { t, alice, aliceWs } = await twoPeople();
    const requestId = await park(t);

    await approveWith(t, alice, requestId, ["context:read"], aliceWs);

    const event = await t.run(async (ctx) => {
      const events = await ctx.db
        .query("auditEvents")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .collect();
      return events.find((row) => row.action === "oauth.authorized");
    });
    expect(event?.details).toMatchObject({
      scope: SCOPE,
      grantedScope: "context:read",
      tier: "team",
    });
  });
});

/**
 * The ceiling, from below.
 *
 * "A grant may never exceed what the approver could do" is the rule; these are
 * the request shapes that try to break it. None of them go through the screen,
 * because the screen is not what stops them.
 */
describe("nobody can grant more than their own role could", () => {
  test("a member cannot obtain private-tier by asking for it", async () => {
    const { t, alice, bob, aliceWs } = await twoPeople();
    await addMember(t, aliceWs, bob, "member", alice);
    const requestId = await park(t);

    await approveWith(
      t,
      bob,
      requestId,
      ["context:read", "context:private"],
      aliceWs,
    );

    expect(await grantedScopeOf(t, requestId)).toBe("context:read");
  });

  test("a member cannot obtain private-tier by having the client request it", async () => {
    const { t, alice, bob, aliceWs } = await twoPeople();
    await addMember(t, aliceWs, bob, "member", alice);
    // A client that asks for everything, and a person who ticks everything.
    const requestId = await park(t, {
      scope: "context:read context:write context:capture context:private",
    });

    await approveWith(
      t,
      bob,
      requestId,
      ["context:read", "context:write", "context:capture", "context:private"],
      aliceWs,
    );

    // Read-only, team tier. A `member` is read-only in the workspace model, so
    // a grant they issue cannot write either.
    expect(await grantedScopeOf(t, requestId)).toBe("context:read");
  });

  test("a member cannot obtain private-tier by spelling it differently", async () => {
    const { t, alice, bob, aliceWs } = await twoPeople();
    await addMember(t, aliceWs, bob, "member", alice);
    const requestId = await park(t, {
      scope: "context:read private context.private *",
    });

    await approveWith(
      t,
      bob,
      requestId,
      ["context:read", "private", "context.private", "*"],
      aliceWs,
    );

    // None of the alternative spellings survive. The gateway only honours the
    // canonical name, but the console renders any of them as "Full access", and
    // a grant that makes the console say private for somebody who has not got
    // it is a lie on the one screen a person checks.
    expect(await grantedScopeOf(t, requestId)).toBe("context:read");
  });

  test("an editor cannot grant private-tier either", async () => {
    const { t, alice, bob, aliceWs } = await twoPeople();
    await addMember(t, aliceWs, bob, "editor", alice);
    const requestId = await park(t);

    await approveWith(
      t,
      bob,
      requestId,
      ["context:read", "context:write", "context:private"],
      aliceWs,
    );

    // An editor writes, so `context:write` stays. They are not the person whose
    // private notes these are, so `context:private` does not.
    expect(await grantedScopeOf(t, requestId)).toBe("context:read context:write");
  });

  test("owning one context does not raise the ceiling in another", async () => {
    const { t, alice, bob, aliceWs } = await twoPeople();
    // Bob owns `alphabet` outright and is only a member of Alice's `alpha`.
    await addMember(t, aliceWs, bob, "member", alice);
    const requestId = await park(t);

    await approveWith(
      t,
      bob,
      requestId,
      ["context:read", "context:write", "context:private"],
      aliceWs,
    );

    // Clamped by his role in the workspace being granted, read in the approving
    // transaction — not by the widest role he holds anywhere.
    expect(await grantedScopeOf(t, requestId)).toBe("context:read");
  });

  test("the screen is only offered controls its approver can honour", async () => {
    const { t, alice, bob, aliceWs } = await twoPeople();
    await addMember(t, aliceWs, bob, "member", alice);
    const requestId = await park(t);

    const view = await read(t, bob, requestId);
    expect(view).toMatchObject({
      workspaceRole: "member",
      // The client asked for write. Bob cannot grant it, so it is not drawn.
      grantableScopes: ["context:read"],
      grantableTiers: ["team"],
    });

    // And the offer matches the enforcement: ticking everything on that screen
    // still produces exactly the offered set.
    await approveWith(
      t,
      bob,
      requestId,
      [...(view as { grantableScopes: string[] }).grantableScopes],
      aliceWs,
    );
    expect(await grantedScopeOf(t, requestId)).toBe("context:read");
  });
});
