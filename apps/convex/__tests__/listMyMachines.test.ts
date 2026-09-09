/**
 * "Your devices" — the account-scoped query behind it.
 *
 * `listMyMachines` used to not exist: the only place a person's own Mac showed
 * up was `ThisMachineCard`, drawn inside *workspace* settings, where every
 * other member of that workspace could see it too. This is the backend for
 * the fix — a query scoped to the signed-in identity (`requireAuthId`, the
 * same auth path every other function in `authorizations.ts` uses), narrowed
 * to the desktop shell's own grants, and answering only what the section
 * needs: a name, when it was approved, what it may capture, and the id
 * `revokeGrant` already takes to cut it off.
 *
 * The load-bearing property, proved directly rather than assumed:
 * **one tenant must not enumerate, read, or infer the existence of another**
 * (`CLAUDE.md`). `oauthGrants` has no workspace-membership check on the read
 * path here — a grant's `userId` *is* the tenant boundary for this query, and
 * the isolation test below sabotages exactly the line that enforces it.
 *
 * Every client, code and credential here is obviously fake. This repository
 * is public.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { MAX_MACHINES_RETURNED } from "../functions/authorizations";
import { DESKTOP_SOFTWARE_ID } from "../functions/lib/machineGrant";
import {
  type TestConvex,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  gatewayPost,
  setupTest,
} from "./fixtures.helpers";

const MACHINE_REDIRECT = "http://127.0.0.1/context-hook/callback";
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
 * A deterministic, obviously-fake 64-character hex string, distinct per seed.
 *
 * `oauthGrants.by_refresh_token` and `.by_access_token` are read with
 * `.unique()` elsewhere in this codebase, so two grants sharing one literal
 * hash — every fixture here mints at least two — would make this file's own
 * setup collide with a real invariant rather than testing around it.
 */
function fakeHash(seed: string): string {
  const alphabet = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 64; i += 1) {
    out += alphabet[(seed.charCodeAt(i % seed.length) + i) % 16];
  }
  return out;
}

/** Register a client the way the desktop shell registers itself. */
async function registerMac(
  t: TestConvex,
  clientId: string,
  clientName: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await gatewayPost(t, "/gateway/clients/register", {
    clientId,
    clientName,
    redirectUris: [MACHINE_REDIRECT],
    hashedClientSecret: null,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scope: MACHINE_SCOPE,
    applicationType: "native",
    softwareId: DESKTOP_SOFTWARE_ID,
    ...overrides,
  });
}

/**
 * Park a request the way `/oauth/authorize` parks the shell's, approve it with
 * no screen, and carry it all the way through the token exchange — the two
 * gateway calls (`/gateway/codes/consume`, `/gateway/grants/create`) that turn
 * an approved *authorization* into an `oauthGrants` row. `listMyMachines`
 * reads that table, not `oauthAuthorizations`, so a fixture that stopped at
 * "approved" would be testing a state this query never sees.
 */
async function approveMachine(
  t: TestConvex,
  userId: Id<"users">,
  clientId: string,
  workspaceSlug: string,
): Promise<void> {
  const started = await gatewayPost(t, "/gateway/authorize/start", {
    clientId,
    redirectUri: REQUEST_REDIRECT,
    state: "a-state-this-machine-minted",
    codeChallenge: await s256(VERIFIER),
    codeChallengeMethod: "S256",
    scope: MACHINE_SCOPE,
    resource: null,
    requestedWorkspaceSlug: workspaceSlug,
  });
  const startedBody = await bodyOf(started);
  if (typeof startedBody.requestId !== "string") {
    throw new Error(`no request parked: ${JSON.stringify(startedBody)}`);
  }

  const { redirectTo } = await asUser(t, userId).action(
    api.functions.authorizations.approveOwnMachineGrant,
    { requestId: startedBody.requestId },
  );
  const code = new URL(redirectTo).searchParams.get("code");
  if (code === null) throw new Error(`no code in redirect: ${redirectTo}`);

  const consumed = await gatewayPost(t, "/gateway/codes/consume", { code, clientId });
  const consumedBody = await bodyOf(consumed);
  const authorization = consumedBody.authorization as
    | { workspaceId: string; userId: string; scope: string }
    | null;
  if (authorization === null) {
    throw new Error(`code did not consume: ${JSON.stringify(consumedBody)}`);
  }

  const created = await gatewayPost(t, "/gateway/grants/create", {
    workspaceId: authorization.workspaceId,
    userId: authorization.userId,
    clientId,
    scopes: authorization.scope.split(" "),
    hashedRefreshToken: fakeHash(`refresh:${clientId}`),
    hashedAccessToken: fakeHash(`access:${clientId}`),
    accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
  });
  const createdBody = await bodyOf(created);
  if (typeof createdBody.grantId !== "string") {
    throw new Error(`grant not created: ${JSON.stringify(createdBody)}`);
  }
}

function listMachines(t: TestConvex, userId: Id<"users">) {
  return asUser(t, userId).query(api.functions.authorizations.listMyMachines, {});
}

/* -------------------------------------------------------------------------- */

describe("a person's own approved machines", () => {
  test("a minted machine grant shows its name, when it was approved, and its tier", async () => {
    const t: TestConvex = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    await createWorkspace(t, alice, "alpha", { displayName: "Alice's Context" });
    await registerMac(t, "mcp_client_alices_mac", "Context on alices-mac");
    await approveMachine(t, alice, "mcp_client_alices_mac", "alpha");

    const machines = await listMachines(t, alice);
    expect(machines).toHaveLength(1);
    expect(machines[0].name).toBe("Context on alices-mac");
    expect(machines[0].tier).toBe("private");
    expect(typeof machines[0].approvedAt).toBe("number");
    expect(typeof machines[0].grantId).toBe("string");
  });

  test("the id returned is exactly the one `revokeGrant` accepts", async () => {
    const t: TestConvex = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    await createWorkspace(t, alice, "alpha");
    await registerMac(t, "mcp_client_alices_mac", "Context on alices-mac");
    await approveMachine(t, alice, "mcp_client_alices_mac", "alpha");

    const before = await listMachines(t, alice);
    expect(before).toHaveLength(1);

    const { revoked } = await asUser(t, alice).mutation(api.functions.grants.revokeGrant, {
      grantId: before[0].grantId,
    });
    expect(revoked).toBe(true);

    // A revoked machine no longer reaches anything, so it drops off the list
    // that answers "what still can".
    expect(await listMachines(t, alice)).toHaveLength(0);
  });

  test("two machines, most recently approved first", async () => {
    const t: TestConvex = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    await createWorkspace(t, alice, "alpha");
    await createWorkspace(t, alice, "second-brain");
    await registerMac(t, "mcp_client_laptop", "Context on laptop");
    await approveMachine(t, alice, "mcp_client_laptop", "alpha");
    await registerMac(t, "mcp_client_desktop", "Context on desktop");
    await approveMachine(t, alice, "mcp_client_desktop", "second-brain");

    const machines = await listMachines(t, alice);
    expect(machines.map((m) => m.name)).toEqual(["Context on desktop", "Context on laptop"]);
  });

  test("a client that never declared itself the desktop shell is not a device", async () => {
    // An ordinary MCP client (Claude, ChatGPT, …) holds a grant too, and
    // `listGrants` in `grants.ts` is where that belongs — not here. The grant
    // row is inserted directly (as `addMember` does for a membership) rather
    // than driven through the full gateway token exchange, which this
    // assertion does not need: what is under test is `listMyMachines`'s own
    // filter, not how an ordinary grant comes to exist.
    const t: TestConvex = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const workspaceId = await createWorkspace(t, alice, "alpha");
    await gatewayPost(t, "/gateway/clients/register", {
      clientId: "mcp_client_claude",
      clientName: "Claude",
      redirectUris: ["https://claude.example.invalid/callback"],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
      scope: "context:read context:write",
      applicationType: "web",
      // No softwareId at all — an ordinary dynamically registered client.
    });
    await t.run((ctx) =>
      ctx.db.insert("oauthGrants", {
        workspaceId,
        userId: alice,
        clientId: "mcp_client_claude",
        scopes: ["context:read", "context:write"],
        hashedRefreshToken: fakeHash("refresh:mcp_client_claude"),
        status: "active",
        createdAt: Date.now(),
      }),
    );

    // The grant is real and belongs to alice — `listGrants` would show it —
    // but it is not a machine, so "Your devices" stays empty.
    expect(await listMachines(t, alice)).toEqual([]);
  });

  test("signed out entirely: refused, not an empty list", async () => {
    const t: TestConvex = setupTest();
    const error = await captureError(() =>
      t.query(api.functions.authorizations.listMyMachines, {}),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });
});

/* -------------------------------------------------------------------------- */
/* Isolation: the property CLAUDE.md calls non-negotiable                     */
/* -------------------------------------------------------------------------- */

describe("one tenant cannot enumerate, read, or infer another's machines", () => {
  test("bob's list is empty even though alice has an approved Mac", async () => {
    const t: TestConvex = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    await createWorkspace(t, alice, "alpha");
    await createWorkspace(t, bob, "bobs-brain");
    await registerMac(t, "mcp_client_alices_mac", "Context on alices-mac");
    await approveMachine(t, alice, "mcp_client_alices_mac", "alpha");

    expect(await listMachines(t, alice)).toHaveLength(1);
    expect(await listMachines(t, bob)).toEqual([]);
  });

  test("each person's own devices only, with several of each in play", async () => {
    const t: TestConvex = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    await createWorkspace(t, alice, "alpha");
    await createWorkspace(t, bob, "bobs-brain");

    await registerMac(t, "mcp_client_alice_1", "Context on alice-laptop");
    await approveMachine(t, alice, "mcp_client_alice_1", "alpha");
    await registerMac(t, "mcp_client_alice_2", "Context on alice-desktop");
    await approveMachine(t, alice, "mcp_client_alice_2", "alpha");
    await registerMac(t, "mcp_client_bob_1", "Context on bobs-laptop");
    await approveMachine(t, bob, "mcp_client_bob_1", "bobs-brain");

    const aliceMachines = (await listMachines(t, alice)).map((m) => m.name).sort();
    const bobMachines = (await listMachines(t, bob)).map((m) => m.name).sort();
    expect(aliceMachines).toEqual(["Context on alice-desktop", "Context on alice-laptop"]);
    expect(bobMachines).toEqual(["Context on bobs-laptop"]);
  });

  /**
   * SABOTAGE RECORD.
   *
   * Run as a temporary local edit to `listMyMachines` and reverted — see the
   * PR description for the exact diff. Counts are failing tests in this file.
   *
   *   dropping `.withIndex("by_user", …)` for a bare `.query("oauthGrants")`
   *   (i.e. every user's grants, unfiltered)                              2
   *
   * Both are the two tests directly above this record. They are the whole
   * point of this `describe` block: a test in the "happy path" block above
   * would still pass with the isolation gone — it only ever looks at one
   * person's own list — so isolation has to be its own assertion, not a
   * hoped-for side effect of the other tests.
   */
});

/* -------------------------------------------------------------------------- */
/* The cap keeps the newest machines, not the oldest                          */
/* -------------------------------------------------------------------------- */

describe("past the cap, the newest machines survive", () => {
  test(`more than ${MAX_MACHINES_RETURNED} machines: the ${MAX_MACHINES_RETURNED} most recently approved are what's returned`, async () => {
    // Convex's default order is ascending by `_creationTime`. A bare
    // `.take(MAX_MACHINES_RETURNED)` with no `.order("desc")` therefore keeps
    // the *oldest* rows — silently hiding the machine approved five minutes
    // ago behind ones approved years ago, on a screen whose entire job is
    // showing what can *currently* capture into someone's contexts. Rows are
    // inserted directly (as the "non-desktop client" test above does): what
    // is under test is `listMyMachines`'s own ordering, not the approval flow,
    // and driving `MAX_MACHINES_RETURNED + 5` machines through the real
    // gateway round trip buys nothing here.
    const t: TestConvex = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const workspaceId = await createWorkspace(t, alice, "alpha");

    const total = MAX_MACHINES_RETURNED + 5;
    for (let i = 0; i < total; i += 1) {
      const clientId = `mcp_client_machine_${i}`;
      await t.run((ctx) =>
        ctx.db.insert("oauthClients", {
          clientId,
          clientName: `Context on machine-${i}`,
          redirectUris: [MACHINE_REDIRECT],
          hashedClientSecret: null,
          softwareId: DESKTOP_SOFTWARE_ID,
          createdAt: Date.now(),
        }),
      );
      await t.run((ctx) =>
        ctx.db.insert("oauthGrants", {
          workspaceId,
          userId: alice,
          clientId,
          scopes: ["context:write", "context:private"],
          hashedRefreshToken: fakeHash(`refresh:${clientId}`),
          status: "active",
          createdAt: Date.now(),
        }),
      );
    }

    const machines = await listMachines(t, alice);
    expect(machines).toHaveLength(MAX_MACHINES_RETURNED);
    const names = new Set(machines.map((m) => m.name));
    // The 5 inserted first are the oldest, and must have been dropped —
    // exactly what a bare ascending `.take()` would keep instead.
    for (let i = 0; i < 5; i += 1) {
      expect(names.has(`Context on machine-${i}`)).toBe(false);
    }
    // The most recently inserted must be the ones kept.
    for (let i = total - MAX_MACHINES_RETURNED; i < total; i += 1) {
      expect(names.has(`Context on machine-${i}`)).toBe(true);
    }
  });

  /**
   * SABOTAGE RECORD.
   *
   * Run as a temporary local edit — `.order("desc")` removed from
   * `listMyMachines`, reverting to Convex's ascending default — and reverted.
   * Counts are failing tests across this file.
   *
   *   dropping `.order("desc")` before `.take(MAX_MACHINES_RETURNED)`        2
   *
   * The second is `"two machines, most recently approved first"`, above in
   * this file: removing the post-hoc `.sort()` that used to paper over a
   * missing `.order("desc")` means that test is now also a direct guard on
   * the ordering, not only the two-machine happy path it reads as.
   */
});
