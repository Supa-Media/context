import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  gatewayPost,
  setupTest,
} from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { CONSOLE_CLIENT_ID, CONSOLE_GRANT_TTL_MS } from "../functions/agentGrant";

/**
 * THE CONSOLE'S OWN GRANT, AND WHY IT IS AN ORDINARY ONE.
 *
 * The agent runs in the gateway, and the gateway authenticates with an OAuth
 * access token and nothing else. This is how the app gets one — and the whole
 * claim being tested is that it gets a *normal* grant: the same table, the same
 * `resolveGrantByAccessToken`, the same clamp, the same revocation, the same
 * audit. A first-party shortcut that produced a special token nothing else in
 * the system could revoke would be non-negotiable #4 quietly reversed.
 *
 * So the tests below spend the minted token on the *real* control-plane route
 * the gateway calls, rather than reading the row back. A grant that exists and
 * does not resolve is not a grant, and a grant that resolves after somebody
 * revoked it is the bug this file exists to catch.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `applyConsoleGrant` storing `CONSOLE_SCOPES` rather than the clamped set.
 *     → **2 fail**: `a member of somebody else's context gets read and no
 *     write` and `an editor gets write but not the private tier`. Three scopes
 *     asked for, three stored, and a member of a shared context holds a write
 *     token for it.
 *  2. The membership check replaced by a hard-coded `owner`, which is what
 *     trusting the workspace argument amounts to.
 *     → **3 fail**: the two above, and `a stranger cannot mint a grant for a
 *     context they are not in`. The third is the one that matters; the first
 *     two failing as well is the useful part, because it means the role is
 *     read in one place and everything downstream of it is evidence.
 *  3. The reuse branch appending a second row instead of patching.
 *     → **1 fails**: `minting twice replaces the token rather than stacking
 *     live ones`. The previous token still resolving is the whole of it.
 *  4. `hashedRefreshToken` written as a constant, which is what somebody does
 *     when a required column has nothing to put in it.
 *     → **1 fails**: `no two console grants share a refresh-token hash`.
 */

const SCOPES_ASKED = ["context:read", "context:write", "context:private"];

async function mint(t: ReturnType<typeof setupTest>, userId: Parameters<typeof asUser>[1], workspaceId: string) {
  return await asUser(t, userId).action(api.functions.agentGrant.mintConsoleGrant, {
    workspaceId: workspaceId as never,
  });
}

/** Spend a token on the route the gateway actually calls with it. */
async function resolves(t: ReturnType<typeof setupTest>, accessToken: string): Promise<boolean> {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  const body = JSON.parse(await response.text()) as { session: unknown };
  return body.session !== null;
}

describe("what the console is handed", () => {
  test("an owner gets a token that the gateway can resolve", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const minted = await mint(t, ownerId, workspaceId);

    expect(minted.accessToken).toMatch(/^cat_[0-9a-f]{64}$/);
    expect(minted.scopes).toEqual(SCOPES_ASKED);
    expect(await resolves(t, minted.accessToken)).toBe(true);
  });

  test("the token expires within the hour, not the day an MCP client gets", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const minted = await mint(t, ownerId, workspaceId);
    const ttl = minted.expiresAt - Date.now();

    expect(ttl).toBeGreaterThan(CONSOLE_GRANT_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(CONSOLE_GRANT_TTL_MS);
  });

  /**
   * The direction `oauthGrants` calls load-bearing: the table holds hashes, so
   * a dump of it is inert. A token stored in plaintext would be a working
   * credential sitting in the control plane.
   */
  test("the plaintext token is never stored", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const minted = await mint(t, ownerId, workspaceId);

    const rows = await t.run(async (ctx) => await ctx.db.query("oauthGrants").collect());
    expect(JSON.stringify(rows)).not.toContain(minted.accessToken);
    expect(rows[0]!.hashedAccessToken).toBe(await hashToken(minted.accessToken));

    const events = await t.run(async (ctx) => await ctx.db.query("auditEvents").collect());
    expect(JSON.stringify(events)).not.toContain(minted.accessToken);
    // Nor its hash: a hash in an audit row is something a stolen token can be
    // compared against by anyone who can read the trail.
    expect(JSON.stringify(events)).not.toContain(await hashToken(minted.accessToken));
    expect(events.some((event) => event.action === "agent.session.opened")).toBe(true);
  });
});

describe("what the role decides", () => {
  test("a member of somebody else's context gets read and no write", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    const mateId = await createUser(t, "mate@example.invalid");
    await addMember(t, workspaceId, mateId, "member");

    const minted = await mint(t, mateId, workspaceId);

    expect(minted.scopes).toEqual(["context:read"]);
    expect(minted.scopes).not.toContain("context:write");
    expect(minted.scopes).not.toContain("context:private");
  });

  test("an editor gets write but not the private tier", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    const editorId = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editorId, "editor");

    const minted = await mint(t, editorId, workspaceId);

    expect(minted.scopes).toContain("context:write");
    expect(minted.scopes).not.toContain("context:private");
  });

  test("a stranger cannot mint a grant for a context they are not in", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    const strangerId = await createUser(t, "stranger@example.invalid");

    const error = await captureError(() => mint(t, strangerId, workspaceId));

    // The same refusal a context that does not exist gets, by construction.
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
    const rows = await t.run(async (ctx) => await ctx.db.query("oauthGrants").collect());
    expect(rows).toHaveLength(0);
  });

  test("signing out is the end of it", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const error = await captureError(() =>
      t.action(api.functions.agentGrant.mintConsoleGrant, {
        workspaceId: workspaceId as never,
      }),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });
});

describe("one live grant, and it is revocable", () => {
  test("independent browser instances remain usable while renewal replaces only its own token", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    const client = asUser(t, ownerId);
    const first = await client.action(api.functions.agentGrant.mintConsoleGrant, { workspaceId, consoleInstanceId: "browser-a" });
    const second = await client.action(api.functions.agentGrant.mintConsoleGrant, { workspaceId, consoleInstanceId: "browser-b" });
    expect(await resolves(t, first.accessToken)).toBe(true);
    expect(await resolves(t, second.accessToken)).toBe(true);
    const renewed = await client.action(api.functions.agentGrant.mintConsoleGrant, { workspaceId, consoleInstanceId: "browser-a" });
    expect(await resolves(t, first.accessToken)).toBe(false);
    expect(await resolves(t, second.accessToken)).toBe(true);
    expect(await resolves(t, renewed.accessToken)).toBe(true);
    const grants = await client.query(api.functions.grants.listGrants, { workspaceId });
    expect(grants.filter(g => g.clientId === CONSOLE_CLIENT_ID)).toHaveLength(2);
    for (const grant of grants) await client.mutation(api.functions.grants.revokeGrant, { grantId: grant.grantId });
    expect(await resolves(t, second.accessToken)).toBe(false);
    expect(await resolves(t, renewed.accessToken)).toBe(false);
  });

  test("minting twice replaces the token rather than stacking live ones", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const first = await mint(t, ownerId, workspaceId);
    const second = await mint(t, ownerId, workspaceId);

    expect(second.accessToken).not.toBe(first.accessToken);

    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("oauthGrants").collect()).filter(
        (row) => row.clientId === CONSOLE_CLIENT_ID,
      ),
    );
    expect(rows).toHaveLength(1);

    // The point of the single row: the older token is dead, in the same
    // transaction that issued the newer one.
    expect(await resolves(t, second.accessToken)).toBe(true);
    expect(await resolves(t, first.accessToken)).toBe(false);
  });

  /**
   * A console grant has no refresh token. The column is required, so it holds
   * the hash of a value that was generated and dropped — a hash no presented
   * token can match. A constant there would make every console grant in the
   * deployment refreshable by one guess.
   */
  test("no two console grants share a refresh-token hash", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const firstWorkspace = await createWorkspace(t, ownerId, "seyi");
    const secondWorkspace = await createWorkspace(t, ownerId, "supa", { kind: "shared" });

    await mint(t, ownerId, firstWorkspace);
    await mint(t, ownerId, secondWorkspace);

    const hashes = await t.run(async (ctx) =>
      (await ctx.db.query("oauthGrants").collect()).map((row) => row.hashedRefreshToken),
    );
    expect(hashes).toHaveLength(2);
    expect(new Set(hashes).size).toBe(2);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("revoking it in the connections list stops the token", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const minted = await mint(t, ownerId, workspaceId);
    expect(await resolves(t, minted.accessToken)).toBe(true);

    const listed = await asUser(t, ownerId).query(api.functions.grants.listGrants, {
      workspaceId,
    });
    const row = listed.find((entry) => entry.clientId === CONSOLE_CLIENT_ID);
    expect(row, "the console's grant is not in the connections list").toBeDefined();

    await asUser(t, ownerId).mutation(api.functions.grants.revokeGrant, {
      grantId: row!.grantId,
    });

    expect(await resolves(t, minted.accessToken)).toBe(false);
  });

  /**
   * Revoked is not reused. Somebody who pressed Disconnect and then opened the
   * agent again gets a new row, so the revoked one stays in their trail as the
   * record that they did.
   */
  test("a revoked grant is left revoked and a new one is minted beside it", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const first = await mint(t, ownerId, workspaceId);
    const listed = await asUser(t, ownerId).query(api.functions.grants.listGrants, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.grants.revokeGrant, {
      grantId: listed.find((entry) => entry.clientId === CONSOLE_CLIENT_ID)!.grantId,
    });

    const second = await mint(t, ownerId, workspaceId);

    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("oauthGrants").collect()).filter(
        (row) => row.clientId === CONSOLE_CLIENT_ID,
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === "revoked")).toHaveLength(1);
    expect(await resolves(t, second.accessToken)).toBe(true);
    expect(await resolves(t, first.accessToken)).toBe(false);
  });
});

describe("the client row", () => {
  test("it is a public client with nowhere to redirect to", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    await mint(t, ownerId, workspaceId);

    const client = await t.run(async (ctx) =>
      await ctx.db
        .query("oauthClients")
        .withIndex("by_clientId", (q) => q.eq("clientId", CONSOLE_CLIENT_ID))
        .unique(),
    );

    expect(client).not.toBeNull();
    /*
      It never performs a redirect flow, so it registers no redirect URI — and
      an empty list is what makes `redirectUriMatches` refuse every one. A
      client id somebody guessed cannot be driven through the authorize
      endpoint to have a code delivered somewhere.
    */
    expect(client!.redirectUris).toEqual([]);
    expect(client!.hashedClientSecret).toBeNull();
    expect(client!.grantTypes).toEqual([]);
  });

  test("it is written once however many times the console mints", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    await mint(t, ownerId, workspaceId);
    await mint(t, ownerId, workspaceId);

    const clients = await t.run(async (ctx) =>
      (await ctx.db.query("oauthClients").collect()).filter(
        (row) => row.clientId === CONSOLE_CLIENT_ID,
      ),
    );
    expect(clients).toHaveLength(1);
  });
});
