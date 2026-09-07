/**
 * The machine grant that is minted with no approve screen, as a security
 * boundary.
 *
 * `approveOwnMachineGrant` is the one place in this codebase where an OAuth
 * authorization is approved by something other than a person pressing Approve.
 * Everything about the grant it produces is unchanged — one client per machine,
 * `context:write context:private` and nothing wider, revocable on its own, an
 * audit row naming the person and the machine, a code delivered to a loopback
 * listener and bound to the flow by PKCE. What changed is who answered, so what
 * is proved here is that the four conditions which stand in for that answer
 * cannot be talked around:
 *
 *  1. **A client that did not declare itself the desktop shell is refused.**
 *     The declaration is client-asserted and this suite says so — what it buys
 *     is scope, not authentication, and the conditions below are what bound the
 *     convenience.
 *  2. **A code that could leave the machine is refused.** Every registered
 *     redirect and the request's own must be `http://127.0.0.1` — not
 *     `localhost`, not a host that merely reads like loopback, and not https
 *     somewhere else.
 *  3. **A widened request is refused.** Set equality with the default, so an
 *     added `context:read` and a dropped `context:private` are both the screen's
 *     business rather than this function's.
 *  4. **An approver whose role cannot grant the tier is refused**, because
 *     auto-approving them would silently mint the narrower grant they never
 *     chose — which is the tier defect #312 fixed, arriving by another door.
 *
 * And the ordinary refusals of the flow still hold through this door: somebody
 * else's request, a replay, an expired request, a caller with no context, and a
 * rate limit on how many machines one person can mint an hour.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests across
 * the whole `apps/convex` suite.
 *
 *   `decideMachineApproval` answering `ok` unconditionally               12
 *   ...dropping the software-id condition                                 2
 *   ...dropping the loopback condition                                    3
 *   ...dropping the scope-equality condition                              5
 *   ...dropping the tier condition                                        2
 *   `isLoopbackRedirect` accepting any hostname                           1
 *   ...accepting `https`                                                  1
 *   the mutation skipping `requireWorkspaceAccess`                        1
 *   the mutation not checking `status === "pending"`                      2
 *   the mutation not checking `expiresAt`                                 1
 *   the rate limit removed                                                1
 *   `arm` not writing `grantedScope`                                     13
 *
 * The `arm` row is the largest because both approvals share that function,
 * which is the point of having one: a refactor that stops recording what was
 * granted reddens the consent screen's tests as well as this file's. And the
 * `isLoopbackRedirect` rows are **1** each because the mutation-level checks
 * above them catch the same class first — the pure function's own block is
 * where each spelling is named, and it is one `expect` per row by design.
 *
 * Every client, code and credential here is obviously fake. This repository is
 * public.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  DESKTOP_SOFTWARE_ID,
  decideMachineApproval,
  isLoopbackRedirect,
} from "../functions/lib/machineGrant";
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

/** The shell registers one client per machine; the name is what a person sees. */
const MACHINE_CLIENT = "mcp_client_this_mac";
/** No port: what the shell registers. The OS hands one out per connect. */
const MACHINE_REDIRECT = "http://127.0.0.1/context-hook/callback";
/** With a port: what the parked request carries, from the live listener. */
const REQUEST_REDIRECT = "http://127.0.0.1:53411/context-hook/callback";
const MACHINE_SCOPE = "context:write context:private";

const VERIFIER = "a".repeat(64);

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier) as BufferSource,
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text());
}

/**
 * A person, their context, and a Mac registered the way the shell registers it.
 *
 * Through the real gateway routes rather than by inserting rows: a fixture that
 * hand-wrote an `oauthClients` row would prove things about a shape no
 * production path produces, and the `software_id` pass-through is exactly the
 * production path this feature depends on.
 */
async function aMacAndItsOwner(
  clientOverrides: Record<string, unknown> = {},
): Promise<{
  t: TestConvex;
  alice: Id<"users">;
  bob: Id<"users">;
  aliceWs: Id<"workspaces">;
}> {
  const t: TestConvex = setupTest();
  const alice = await createUser(t, "alice@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");
  const aliceWs = await createWorkspace(t, alice, "alpha", {
    displayName: "Alice's Context",
  });
  await createWorkspace(t, bob, "alphabet", { displayName: "Bob's Context" });

  await gatewayPost(t, "/gateway/clients/register", {
    clientId: MACHINE_CLIENT,
    clientName: "Context on a-laptop",
    redirectUris: [MACHINE_REDIRECT],
    hashedClientSecret: null,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scope: MACHINE_SCOPE,
    applicationType: "native",
    softwareId: DESKTOP_SOFTWARE_ID,
    ...clientOverrides,
  });

  return { t, alice, bob, aliceWs };
}

/** Park a request the way `/oauth/authorize` parks the shell's. */
async function parkMachineRequest(
  t: TestConvex,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await gatewayPost(t, "/gateway/authorize/start", {
    clientId: MACHINE_CLIENT,
    redirectUri: REQUEST_REDIRECT,
    state: "a-state-this-machine-minted",
    codeChallenge: await s256(VERIFIER),
    codeChallengeMethod: "S256",
    scope: MACHINE_SCOPE,
    resource: null,
    requestedWorkspaceSlug: "alpha",
    ...overrides,
  });
  const body = await bodyOf(response);
  if (typeof body.requestId !== "string") {
    throw new Error(`no request parked: ${JSON.stringify(body)}`);
  }
  return body.requestId;
}

function mint(t: TestConvex, userId: Id<"users">, requestId: string) {
  return asUser(t, userId).action(
    api.functions.authorizations.approveOwnMachineGrant,
    { requestId },
  );
}

async function rowOf(t: TestConvex, requestId: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("oauthAuthorizations")
      .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
      .unique();
    if (row === null) throw new Error("no such request");
    return row;
  });
}

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

/** The refusal reason, when the error is this feature's own. */
function refusalReason(error: unknown): string | undefined {
  const data = (error as { data?: { reason?: unknown } } | null)?.data;
  return typeof data?.reason === "string" ? data.reason : undefined;
}

/* -------------------------------------------------------------------------- */
/* The happy path, which is the whole point                                   */
/* -------------------------------------------------------------------------- */

describe("a signed-in person's own Mac gets its grant with no screen", () => {
  test("mints a code, at the default scope, for the context the screen would have named", async () => {
    const { t, alice, aliceWs } = await aMacAndItsOwner();
    const requestId = await parkMachineRequest(t);

    const { redirectTo, workspaceSlug } = await mint(t, alice, requestId);

    // The code goes back to this machine's own loopback listener, carrying the
    // state the flow minted, exactly as the approve screen's redirect does.
    const url = new URL(redirectTo);
    expect(`${url.origin}${url.pathname}`).toBe(REQUEST_REDIRECT);
    expect(url.searchParams.get("state")).toBe("a-state-this-machine-minted");
    expect(url.searchParams.get("code")).toMatch(/^.{16,}$/);
    expect(workspaceSlug).toBe("alpha");

    const row = await rowOf(t, requestId);
    expect(row.status).toBe("approved");
    expect(row.workspaceId).toBe(aliceWs);
    expect(row.userId).toBe(alice);
    // Exactly the default. Not the approver's ceiling, not the request read
    // back to itself: the two scopes the desktop asks for.
    expect(row.grantedScope).toBe(MACHINE_SCOPE);
    // The plaintext code lives in the redirect and nowhere else.
    expect(row.hashedCode).not.toContain(url.searchParams.get("code"));
  });

  test("the audit row names the person, the machine, and how it was approved", async () => {
    const { t, alice, aliceWs } = await aMacAndItsOwner();
    const requestId = await parkMachineRequest(t);
    await mint(t, alice, requestId);

    const events = await t.run(async (ctx) =>
      await ctx.db
        .query("auditEvents")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .collect(),
    );
    const authorized = events.filter((event) => event.action === "oauth.authorized");
    expect(authorized).toHaveLength(1);
    expect(authorized[0].actorUserId).toBe(alice);
    expect(authorized[0].actorClientId).toBe(MACHINE_CLIENT);
    expect(authorized[0].details).toMatchObject({
      approval: "own-machine",
      clientName: "Context on a-laptop",
      grantedScope: MACHINE_SCOPE,
      tier: "private",
    });
  });

  test("a second machine is a second client and a second grant", async () => {
    const { t, alice } = await aMacAndItsOwner();
    const first = await parkMachineRequest(t);
    await mint(t, alice, first);

    await gatewayPost(t, "/gateway/clients/register", {
      clientId: "mcp_client_the_other_mac",
      clientName: "Context on another-laptop",
      redirectUris: [MACHINE_REDIRECT],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
      scope: MACHINE_SCOPE,
      applicationType: "native",
      softwareId: DESKTOP_SOFTWARE_ID,
    });
    const second = await parkMachineRequest(t, {
      clientId: "mcp_client_the_other_mac",
    });
    await mint(t, alice, second);

    // Two rows, two clients: revoking the laptop you lost leaves the one on
    // your desk connected. That is the property the per-machine client exists
    // for and it survives the screen going away.
    expect((await rowOf(t, first)).clientId).toBe(MACHINE_CLIENT);
    expect((await rowOf(t, second)).clientId).toBe("mcp_client_the_other_mac");
  });
});

/* -------------------------------------------------------------------------- */
/* The four conditions                                                        */
/* -------------------------------------------------------------------------- */

describe("only the desktop shell's own request is minted without a screen", () => {
  test("A CLIENT THAT DID NOT DECLARE ITSELF THE SHELL IS REFUSED", async () => {
    const { t, alice } = await aMacAndItsOwner({ softwareId: undefined });
    const requestId = await parkMachineRequest(t);

    const error = await captureError(() => mint(t, alice, requestId));
    expect(errorCode(error)).toBe("MACHINE_APPROVAL_REFUSED");
    expect(refusalReason(error)).toBe("not-the-desktop-shell");
    // Nothing was armed: the request is still there for the screen to answer.
    expect((await rowOf(t, requestId)).status).toBe("pending");
  });

  test("...and so is one declaring something else entirely", async () => {
    const { t, alice } = await aMacAndItsOwner({ softwareId: "com.example.other" });
    const requestId = await parkMachineRequest(t);

    expect(refusalReason(await captureError(() => mint(t, alice, requestId)))).toBe(
      "not-the-desktop-shell",
    );
  });

  test("A CODE THAT COULD LEAVE THIS MACHINE IS REFUSED", async () => {
    // The client is the shell by declaration, and its registered redirect is on
    // the internet. This is the shape a forged `software_id` takes when it is
    // trying to have the code delivered somewhere it can read it.
    const { t, alice } = await aMacAndItsOwner({
      redirectUris: ["https://attacker.invalid/callback"],
    });
    const requestId = await parkMachineRequest(t, {
      redirectUri: "https://attacker.invalid/callback",
    });

    expect(refusalReason(await captureError(() => mint(t, alice, requestId)))).toBe(
      "not-loopback",
    );
    expect((await rowOf(t, requestId)).status).toBe("pending");
  });

  test("...including a client that registered loopback AND somewhere on the internet", async () => {
    const { t, alice } = await aMacAndItsOwner({
      redirectUris: [MACHINE_REDIRECT, "https://attacker.invalid/callback"],
    });
    // This request is on loopback, so this code would come back here. The
    // refusal is on the *registration*: a client holding a redirect off this
    // machine is not a machine-only client, and the next request from it is not
    // one anybody would have to park through this app to make.
    const requestId = await parkMachineRequest(t);

    expect(refusalReason(await captureError(() => mint(t, alice, requestId)))).toBe(
      "not-loopback",
    );
  });

  test("A WIDER REQUEST IS THE SCREEN'S BUSINESS", async () => {
    const { t, alice } = await aMacAndItsOwner();
    const requestId = await parkMachineRequest(t, {
      scope: "context:read context:write context:private",
    });

    expect(refusalReason(await captureError(() => mint(t, alice, requestId)))).toBe(
      "scope-is-not-the-default",
    );
  });

  test("...and so is a narrower one, because a silent narrowing is what the tier defect was", async () => {
    const { t, alice } = await aMacAndItsOwner();
    const requestId = await parkMachineRequest(t, { scope: "context:write" });

    expect(refusalReason(await captureError(() => mint(t, alice, requestId)))).toBe(
      "scope-is-not-the-default",
    );
  });

  test("AN APPROVER WHO CANNOT GRANT THE TIER GETS THE SCREEN", async () => {
    const { t, alice, bob, aliceWs } = await aMacAndItsOwner();
    // Bob is an editor in Alice's context: he can write, and he cannot hand
    // over her private notes. Auto-approving him would mint a team-tier grant
    // he never chose, and every meeting the Mac recorded would be filed to
    // everybody he shares a folder with.
    await addMember(t, aliceWs, bob, "editor", alice);
    const requestId = await parkMachineRequest(t, {
      requestedWorkspaceSlug: "alpha",
    });

    expect(refusalReason(await captureError(() => mint(t, bob, requestId)))).toBe(
      "tier-not-grantable",
    );
    expect((await rowOf(t, requestId)).status).toBe("pending");
  });
});

/* -------------------------------------------------------------------------- */
/* The refusals the flow already had, through this door                       */
/* -------------------------------------------------------------------------- */

describe("the ordinary refusals still hold with no screen in the way", () => {
  test("an unauthenticated caller mints nothing", async () => {
    const { t } = await aMacAndItsOwner();
    const requestId = await parkMachineRequest(t);

    const error = await captureError(
      () => t.action(api.functions.authorizations.approveOwnMachineGrant, { requestId }),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
    expect((await rowOf(t, requestId)).status).toBe("pending");
  });

  test("A REQUEST CANNOT BE MINTED TWICE", async () => {
    const { t, alice } = await aMacAndItsOwner();
    const requestId = await parkMachineRequest(t);
    await mint(t, alice, requestId);

    const error = await captureError(() => mint(t, alice, requestId));
    expect(errorCode(error)).toBe("AUTHORIZATION_REQUEST_NOT_FOUND");
  });

  test("an expired request is refused here too, not only on the screen", async () => {
    const { t, alice } = await aMacAndItsOwner();
    const requestId = await parkMachineRequest(t);
    await expire(t, requestId);

    expect(errorCode(await captureError(() => mint(t, alice, requestId)))).toBe(
      "AUTHORIZATION_REQUEST_NOT_FOUND",
    );
  });

  test("SOMEBODY ELSE'S PARKED REQUEST GRANTS THEIR CONTEXT NOTHING", async () => {
    const { t, bob, aliceWs } = await aMacAndItsOwner();
    // Alice's Mac parked this, naming her context. Bob is signed in somewhere
    // else and holds the id.
    const requestId = await parkMachineRequest(t);

    const { workspaceSlug } = await mint(t, bob, requestId);

    // It resolved to *his* own context, never hers — `resolveConsentWorkspace`
    // only ever returns a workspace the caller belongs to, and the slug on the
    // request is a hint rather than an instruction.
    expect(workspaceSlug).toBe("alphabet");
    expect((await rowOf(t, requestId)).workspaceId).not.toBe(aliceWs);
  });

  test("...and the most that costs her is the screen she would have had anyway", async () => {
    /*
      The residual, stated rather than left to be discovered.

      A signed-in third party holding a live request id cannot reach Alice's
      context with it — the test above — but they *can* spend it, and then her
      own page's mint finds a row that is no longer pending. That is the burn,
      and it is bounded twice over: the id reaches nobody but the process that
      followed the parking redirect and the page the shell handed it to (a
      foreign origin gets no bridge, and the card reads it from nowhere else,
      which `apps/mobile/__tests__/meetingsDesktop.test.ts` holds), and the
      outcome is the refusal every other condition here produces — #312's
      approve screen, in her own window, on a second parked request.

      What Bob is left holding is a code for **his** context that he cannot
      redeem: the PKCE verifier for it never left Alice's Mac.
    */
    const { t, alice, bob } = await aMacAndItsOwner();
    const requestId = await parkMachineRequest(t);
    await mint(t, bob, requestId);

    expect(errorCode(await captureError(() => mint(t, alice, requestId)))).toBe(
      "AUTHORIZATION_REQUEST_NOT_FOUND",
    );
    // Her machine's next connect parks its own request and is minted normally,
    // so a burn costs a screen rather than the ability to connect at all.
    const second = await parkMachineRequest(t);
    expect((await mint(t, alice, second)).workspaceSlug).toBe("alpha");
  });

  test("a caller with no context of their own learns nothing and grants nothing", async () => {
    const { t } = await aMacAndItsOwner();
    const stranger = await createUser(t, "stranger@example.invalid");
    const requestId = await parkMachineRequest(t);

    expect(errorCode(await captureError(() => mint(t, stranger, requestId)))).toBe(
      "NO_GRANTABLE_WORKSPACE",
    );
    expect((await rowOf(t, requestId)).status).toBe("pending");
  });

  test("A LOOP OF MACHINES IS RATE LIMITED", async () => {
    const { t, alice } = await aMacAndItsOwner();

    for (let index = 0; index < 3; index += 1) {
      const requestId = await parkMachineRequest(t);
      await mint(t, alice, requestId);
    }

    const fourth = await parkMachineRequest(t);
    expect(errorCode(await captureError(() => mint(t, alice, fourth)))).toBe("RATE_LIMITED");
    expect((await rowOf(t, fourth)).status).toBe("pending");
  });

  test("a refused attempt costs no budget, because the transaction rolled back", async () => {
    const { t, alice } = await aMacAndItsOwner();
    // Three refusals — a scope this machine does not send — and then three real
    // ones, which all succeed. A limiter that counted attempts would have
    // locked the person out of connecting their own laptop.
    for (let index = 0; index < 3; index += 1) {
      const wide = await parkMachineRequest(t, { scope: "context:read" });
      await captureError(() => mint(t, alice, wide));
    }
    for (let index = 0; index < 3; index += 1) {
      const requestId = await parkMachineRequest(t);
      await mint(t, alice, requestId);
      expect((await rowOf(t, requestId)).status).toBe("approved");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The decision function, driven directly                                     */
/* -------------------------------------------------------------------------- */

describe("what counts as this person's own machine", () => {
  const facts = {
    clientSoftwareId: DESKTOP_SOFTWARE_ID,
    clientRedirectUris: [MACHINE_REDIRECT],
    requestRedirectUri: REQUEST_REDIRECT,
    requestScope: MACHINE_SCOPE,
    role: "owner",
  };

  test("the shell, on loopback, at the default, for an owner", () => {
    expect(decideMachineApproval(facts)).toEqual({
      ok: true,
      scopes: ["context:write", "context:private"],
    });
  });

  test("the scope comparison is a set, not a string", () => {
    expect(
      decideMachineApproval({ ...facts, requestScope: "context:private context:write" }).ok,
    ).toBe(true);
    // Whitespace is scope syntax, not meaning.
    expect(decideMachineApproval({ ...facts, requestScope: "context:write   context:private" }).ok).toBe(
      true,
    );
    // A duplicate is not a third scope, but it is also not the default said
    // twice: the set has two members either way, so this is accepted, and the
    // check that matters is the one below.
    expect(decideMachineApproval({ ...facts, requestScope: "context:write context:write" }).ok).toBe(
      false,
    );
  });

  test("AN ALIAS SPELLING OF THE TIER IS NOT THE DEFAULT", () => {
    // `*` and `all` are private-tier aliases everywhere else in the control
    // plane. They are not normalised here: the desktop sends two exact strings,
    // so anything else is a request this app did not make.
    expect(decideMachineApproval({ ...facts, requestScope: "context:write *" }).ok).toBe(false);
    expect(decideMachineApproval({ ...facts, requestScope: "context:write all" }).ok).toBe(false);
  });

  test("loopback is the literal, and only the literal", () => {
    expect(isLoopbackRedirect("http://127.0.0.1/context-hook/callback")).toBe(true);
    expect(isLoopbackRedirect("http://127.0.0.1:53411/context-hook/callback")).toBe(true);
    // A name somebody else's DNS can answer.
    expect(isLoopbackRedirect("http://localhost:53411/context-hook/callback")).toBe(false);
    // A routable host that merely reads like loopback.
    expect(isLoopbackRedirect("http://127.0.0.1.attacker.invalid/cb")).toBe(false);
    // Same address, but this is not a scheme a loopback listener serves, and
    // the point of allowing cleartext at all is that it cannot leave the box.
    expect(isLoopbackRedirect("https://127.0.0.1:53411/cb")).toBe(false);
    // The origin alone is not a callback path, and a query is not compared
    // later so it is refused here rather than half-matched there.
    expect(isLoopbackRedirect("http://127.0.0.1:53411/")).toBe(false);
    expect(isLoopbackRedirect("http://127.0.0.1:53411/cb?code=x")).toBe(false);
    expect(isLoopbackRedirect("not a url")).toBe(false);
  });

  test("a member's role is refused before anything else about them is read", () => {
    expect(decideMachineApproval({ ...facts, role: "member" })).toEqual({
      ok: false,
      reason: "tier-not-grantable",
    });
    expect(decideMachineApproval({ ...facts, role: "editor" }).ok).toBe(false);
  });

  test("a client with no registered redirect at all is refused", () => {
    expect(decideMachineApproval({ ...facts, clientRedirectUris: [] })).toEqual({
      ok: false,
      reason: "not-loopback",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The literal that has a twin in another app                                 */
/* -------------------------------------------------------------------------- */

describe("the software id agrees with the app that declares it", () => {
  test("`DESKTOP_SOFTWARE_ID` is the string `apps/desktop` registers with", () => {
    // The desktop shell cannot import this package and this package cannot
    // import the shell, so the pair is held the way `linkParity.test.ts` holds
    // the link engine's twin in the gateway: by reading the other file. The
    // desktop suite reads this one back, so a rename on either side reddens on
    // whichever suite the change touches.
    const connect = readFileSync(
      fileURLToPath(new URL("../../desktop/src/main/connect.ts", import.meta.url)),
      "utf8",
    );
    const match = connect.match(/DESKTOP_SOFTWARE_ID = "([^"]+)"/);
    expect(match?.[1]).toBe(DESKTOP_SOFTWARE_ID);
  });
});
