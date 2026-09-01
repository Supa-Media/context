/**
 * Per-client grants.
 *
 * The property the whole design exists for: revoking one AI client cuts off
 * exactly that client. If revocation were coarser, "connect Context to
 * everything" would mean "one bad client costs you every client".
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { MAX_ACCESS_TOKEN_TTL_MS } from "../functions/lib/consentScopes";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedGrant,
  setupTest,
} from "./fixtures.helpers";

/** One person, one context, three AI clients connected. */
async function threeClients() {
  const t = setupTest();
  const user = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, user, "atlas");

  const claude = await seedGrant(t, workspaceId, user, "claude", "hash-claude");
  const chatgpt = await seedGrant(t, workspaceId, user, "chatgpt", "hash-chatgpt");
  const codex = await seedGrant(t, workspaceId, user, "codex", "hash-codex");

  return { t, user, workspaceId, claude, chatgpt, codex };
}

describe("revokeGrant", () => {
  test("revokes exactly one client and leaves the siblings working", async () => {
    const { t, user, claude } = await threeClients();

    await asUser(t, user).mutation(api.functions.grants.revokeGrant, {
      grantId: claude,
    });

    // The revoked client's refresh token no longer resolves...
    expect(
      await t.query(internal.functions.grants.resolveGrantByRefreshToken, {
        hashedRefreshToken: "hash-claude",
      }),
    ).toBeNull();

    // ...and every sibling still does.
    for (const hash of ["hash-chatgpt", "hash-codex"]) {
      const resolved = await t.query(
        internal.functions.grants.resolveGrantByRefreshToken,
        { hashedRefreshToken: hash },
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.role).toBe("owner");
    }
  });

  test("revoking all three, one at a time, degrades cleanly", async () => {
    const { t, user, claude, chatgpt, codex } = await threeClients();

    for (const grantId of [claude, chatgpt, codex]) {
      const result = await asUser(t, user).mutation(
        api.functions.grants.revokeGrant,
        { grantId },
      );
      expect(result.revoked).toBe(true);
    }

    for (const hash of ["hash-claude", "hash-chatgpt", "hash-codex"]) {
      expect(
        await t.query(internal.functions.grants.resolveGrantByRefreshToken, {
          hashedRefreshToken: hash,
        }),
      ).toBeNull();
    }
  });

  test("is idempotent — revoking twice is not an error and does not restamp the time", async () => {
    const { t, user, claude } = await threeClients();

    await asUser(t, user).mutation(api.functions.grants.revokeGrant, {
      grantId: claude,
    });
    const revokedAt = (await t.run((ctx) => ctx.db.get(claude)))?.revokedAt;

    const second = await asUser(t, user).mutation(
      api.functions.grants.revokeGrant,
      { grantId: claude },
    );
    expect(second.revoked).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(claude)))?.revokedAt).toBe(revokedAt);
  });

  test("records who revoked what, including the client", async () => {
    const { t, user, workspaceId, claude } = await threeClients();

    await asUser(t, user).mutation(api.functions.grants.revokeGrant, {
      grantId: claude,
    });

    const events = await asUser(t, user).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    const revocation = events.find((e) => e.action === "grant.revoked");
    expect(revocation).toBeDefined();
    expect(revocation!.actorUserId).toBe(user);
    expect(revocation!.actorClientId).toBe("claude");
  });

  test("requires authentication", async () => {
    const { t, claude } = await threeClients();
    expect(
      errorCode(
        await captureError(() =>
          t.mutation(api.functions.grants.revokeGrant, { grantId: claude }),
        ),
      ),
    ).toBe("NOT_AUTHENTICATED");
  });
});

describe("listGrants", () => {
  test("shows the connected clients without their token hashes", async () => {
    const { t, user, workspaceId } = await threeClients();
    const grants = await asUser(t, user).query(api.functions.grants.listGrants, {
      workspaceId,
    });

    expect(grants.map((g) => g.clientId).sort()).toEqual([
      "chatgpt",
      "claude",
      "codex",
    ]);
    expect(JSON.stringify(grants)).not.toContain("hash-claude");
  });

  test("keeps showing a revoked grant, so the history is visible", async () => {
    const { t, user, workspaceId, claude } = await threeClients();
    await asUser(t, user).mutation(api.functions.grants.revokeGrant, {
      grantId: claude,
    });

    const grants = await asUser(t, user).query(api.functions.grants.listGrants, {
      workspaceId,
    });
    const revoked = grants.find((g) => g.clientId === "claude");
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokedAt).toBeGreaterThan(0);
  });

  test("names the client when it has registered", async () => {
    const { t, user, workspaceId } = await threeClients();
    await t.mutation(internal.functions.grants.registerClient, {
      clientId: "claude",
      clientName: "Claude Desktop",
      redirectUris: ["https://client.example/callback"],
      hashedClientSecret: null,
    });

    const grants = await asUser(t, user).query(api.functions.grants.listGrants, {
      workspaceId,
    });
    expect(grants.find((g) => g.clientId === "claude")?.clientName).toBe(
      "Claude Desktop",
    );
  });
});

describe("registerClient (RFC 7591, internal)", () => {
  test("is idempotent on clientId so a redeploy does not orphan grants", async () => {
    const t = setupTest();

    const first = await t.mutation(internal.functions.grants.registerClient, {
      clientId: "claude",
      clientName: "Claude",
      redirectUris: ["https://client.example/callback"],
      hashedClientSecret: null,
    });
    const second = await t.mutation(internal.functions.grants.registerClient, {
      clientId: "claude",
      clientName: "Claude Desktop",
      redirectUris: ["https://client.example/callback2"],
      hashedClientSecret: "hashed-secret",
    });

    expect(second).toBe(first);
    const clients = await t.run((ctx) => ctx.db.query("oauthClients").collect());
    expect(clients).toHaveLength(1);
    expect(clients[0].clientName).toBe("Claude Desktop");
  });

  test("supports public clients with no secret", async () => {
    const t = setupTest();
    await t.mutation(internal.functions.grants.registerClient, {
      clientId: "public-client",
      clientName: "Some PKCE Client",
      redirectUris: ["https://client.example/callback"],
      hashedClientSecret: null,
    });
    const client = await t.query(internal.functions.grants.getClient, {
      clientId: "public-client",
    });
    expect(client?.hashedClientSecret).toBeNull();
  });

  test("getClient returns null for an unregistered client", async () => {
    const t = setupTest();
    expect(
      await t.query(internal.functions.grants.getClient, {
        clientId: "never-registered",
      }),
    ).toBeNull();
  });
});

/**
 * What `createGrant` will and will not write.
 *
 * `hashedRefreshToken: v.string()` accepted `""`, and an empty hash is not an
 * unusable grant — it is a grant every *other* empty hash resolves to, so the
 * next blank one written would inherit this workspace. And a `clientId` that
 * nothing registered describes an authority nobody can attribute; there is no
 * legitimate flow that produces one, since registration precedes authorization
 * in OAuth.
 */
describe("createGrant (internal)", () => {
  async function registeredWorkspace() {
    const t = setupTest();
    const user = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, user, "atlas");
    await t.mutation(internal.functions.grants.registerClient, {
      clientId: "claude",
      clientName: "Claude",
      redirectUris: ["https://client.example/callback"],
      hashedClientSecret: null,
    });
    return { t, user, workspaceId };
  }

  const VALID_HASH = "a".repeat(64);

  test("writes a grant for a registered client and a real token hash", async () => {
    const { t, user, workspaceId } = await registeredWorkspace();
    const grantId = await t.mutation(internal.functions.grants.createGrant, {
      workspaceId,
      userId: user,
      clientId: "claude",
      scopes: ["context.read"],
      hashedRefreshToken: VALID_HASH,
    });
    expect(await t.run((ctx) => ctx.db.get(grantId))).not.toBeNull();
  });

  /**
   * `createGrant` clamps `scopes` and says why: "A gateway that is compromised,
   * confused, or simply newer than this deployment must not be able to write
   * `context:private` onto a member's grant by sending it." The access token's
   * lifetime arrived from the same place and was written verbatim.
   *
   * `resolveLiveGrant` only ever asks whether the stored expiry is in the past,
   * no cron sweeps `oauthGrants`, and the one-hour TTL is a constant in
   * `apps/mcp/src/oauth.js` — on the side this clamp is written to distrust. So
   * a gateway that could send scopes it should not could equally send
   * `accessTokenExpiresAt: 4e15` and turn a transient compromise into an access
   * token good for the next hundred thousand years, for every workspace that
   * connected during it. Revocation still works; nothing surfaces the anomaly.
   */
  test("a grant's access token cannot outlive the server-side ceiling", async () => {
    const { t, user, workspaceId } = await registeredWorkspace();
    const absurd = Date.now() + 100_000 * 365 * 24 * 60 * 60 * 1000;
    const grantId = await t.mutation(internal.functions.grants.createGrant, {
      workspaceId,
      userId: user,
      clientId: "claude",
      scopes: ["context.read"],
      hashedRefreshToken: VALID_HASH,
      hashedAccessToken: VALID_HASH,
      accessTokenExpiresAt: absurd,
    });
    const grant = await t.run((ctx) => ctx.db.get(grantId));
    expect(grant?.accessTokenExpiresAt).toBeLessThan(absurd);
    expect(grant?.accessTokenExpiresAt).toBeLessThanOrEqual(
      Date.now() + MAX_ACCESS_TOKEN_TTL_MS + 1000
    );
  });

  test("an ordinary hour-long expiry is written through untouched", async () => {
    const { t, user, workspaceId } = await registeredWorkspace();
    const ordinary = Date.now() + 60 * 60 * 1000;
    const grantId = await t.mutation(internal.functions.grants.createGrant, {
      workspaceId,
      userId: user,
      clientId: "claude",
      scopes: ["context.read"],
      hashedRefreshToken: VALID_HASH,
      hashedAccessToken: VALID_HASH,
      accessTokenExpiresAt: ordinary,
    });
    const grant = await t.run((ctx) => ctx.db.get(grantId));
    expect(grant?.accessTokenExpiresAt).toBe(ordinary);
  });

  /**
   * And the same ceiling on the ROTATE path, which is the one that matters
   * more: a compromised gateway holding a refresh token re-mints on every
   * rotation, so rotate is what turns a transient compromise into a standing
   * one. Sabotaging the clamp at its `createGrant` call site fails the check
   * above; sabotaging it at `rotateGrant`'s used to fail nothing.
   */
  test("a rotated access token cannot outlive the ceiling either", async () => {
    const { t, user, workspaceId } = await registeredWorkspace();
    await t.mutation(internal.functions.grants.createGrant, {
      workspaceId,
      userId: user,
      clientId: "claude",
      scopes: ["context.read"],
      hashedRefreshToken: "d".repeat(64),
      hashedAccessToken: VALID_HASH,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    });
    const absurd = Date.now() + 100_000 * 365 * 24 * 60 * 60 * 1000;
    const rotated = await t.mutation(internal.functions.controlPlane.rotateGrant, {
      hashedRefreshToken: "d".repeat(64),
      clientId: "claude",
      newHashedRefreshToken: "e".repeat(64),
      newHashedAccessToken: "f".repeat(64),
      accessTokenExpiresAt: absurd,
      scopes: null,
    });
    expect(rotated, "the rotation itself must succeed").not.toBeNull();
    const grant = await t.run((ctx) => ctx.db.get(rotated!.grantId));
    expect(grant?.accessTokenExpiresAt).toBeLessThan(absurd);
    expect(grant?.accessTokenExpiresAt).toBeLessThanOrEqual(
      Date.now() + MAX_ACCESS_TOKEN_TTL_MS + 1000
    );
  });

  /**
   * A non-finite expiry is the value the ceiling exists to stop, and the first
   * version of the clamp handed it straight back: `Infinity` and `NaN` both
   * make `accessTokenExpiresAt <= Date.now()` false, which is an access token
   * that never expires. Only a validator in a different file on the HTTP edge
   * made it unreachable, while these are internal mutations taking `v.number()`.
   */
  test("a non-finite expiry is clamped, not passed through", async () => {
    const { t, user, workspaceId } = await registeredWorkspace();
    for (const hostile of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const grantId = await t.mutation(internal.functions.grants.createGrant, {
        workspaceId,
        userId: user,
        clientId: "claude",
        scopes: ["context.read"],
        hashedRefreshToken: "a".repeat(64),
        hashedAccessToken: VALID_HASH,
        accessTokenExpiresAt: hostile,
      });
      const grant = await t.run((ctx) => ctx.db.get(grantId));
      const stored = grant?.accessTokenExpiresAt;
      expect(Number.isFinite(stored), `${hostile} must not survive`).toBe(true);
      expect(stored).toBeLessThanOrEqual(Date.now() + MAX_ACCESS_TOKEN_TTL_MS + 1000);
    }
  });

  test("refuses an empty or non-hash refresh token", async () => {
    const { t, user, workspaceId } = await registeredWorkspace();

    for (const hashedRefreshToken of [
      "",
      "not-a-hash",
      "A".repeat(64), // uppercase: not what hashToken emits
      "a".repeat(63),
    ]) {
      const error = await captureError(() =>
        t.mutation(internal.functions.grants.createGrant, {
          workspaceId,
          userId: user,
          clientId: "claude",
          scopes: ["context.read"],
          hashedRefreshToken,
        }),
      );
      expect(errorCode(error), `${hashedRefreshToken} was accepted`).toBe(
        "INVALID_TOKEN_HASH",
      );
    }
    expect(await t.run((ctx) => ctx.db.query("oauthGrants").collect())).toEqual([]);
  });

  test("refuses a client nobody registered", async () => {
    const { t, user, workspaceId } = await registeredWorkspace();
    const error = await captureError(() =>
      t.mutation(internal.functions.grants.createGrant, {
        workspaceId,
        userId: user,
        clientId: "never-registered",
        scopes: ["context.read"],
        hashedRefreshToken: VALID_HASH,
      }),
    );
    expect(errorCode(error)).toBe("CLIENT_NOT_REGISTERED");
  });

  /**
   * The clamp `createGrant` performs is not the same clamp `applyApproval`
   * performs, and the difference is the whole reason both exist.
   *
   * `applyApproval` is driven by a signed-in person in a browser. This is
   * driven by the gateway, relaying a value that made a round trip through a
   * Cloudflare Worker. If only the approval clamped, then "the gateway sends
   * `context:private` for a member's grant" — a compromise, a bug, or simply a
   * Worker newer than this deployment — would write private-tier onto a grant
   * no person could have issued.
   */
  test("clamps a relayed scope set to what the grant's own role could hand over", async () => {
    const { t, workspaceId } = await registeredWorkspace();
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "member");

    const grantId = await t.mutation(internal.functions.grants.createGrant, {
      workspaceId,
      userId: member,
      clientId: "claude",
      scopes: ["context:read", "context:write", "context:private"],
      hashedRefreshToken: VALID_HASH,
    });

    const grant = await t.run((ctx) => ctx.db.get(grantId));
    expect(grant?.scopes).toEqual(["context:read"]);
  });

  test("clamps private-tier off an editor's grant and leaves write alone", async () => {
    const { t, workspaceId } = await registeredWorkspace();
    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor");

    const grantId = await t.mutation(internal.functions.grants.createGrant, {
      workspaceId,
      userId: editor,
      clientId: "claude",
      scopes: ["context:read", "context:write", "context:private"],
      hashedRefreshToken: VALID_HASH,
    });

    expect((await t.run((ctx) => ctx.db.get(grantId)))?.scopes).toEqual([
      "context:read",
      "context:write",
    ]);
  });

  test("leaves an owner's private-tier grant exactly as approved", async () => {
    const { t, user, workspaceId } = await registeredWorkspace();

    const grantId = await t.mutation(internal.functions.grants.createGrant, {
      workspaceId,
      userId: user,
      clientId: "claude",
      scopes: ["context:read", "context:private"],
      hashedRefreshToken: VALID_HASH,
    });

    expect((await t.run((ctx) => ctx.db.get(grantId)))?.scopes).toEqual([
      "context:read",
      "context:private",
    ]);
  });

  test("answers the authorization question before the validation ones", async () => {
    const { t, workspaceId } = await registeredWorkspace();
    const stranger = await createUser(t, "stranger@example.invalid");

    // Malformed *and* unauthorized. Which complaint comes back must not depend
    // on the request being well-formed, or the shape of the error becomes a
    // way to probe which workspace ids are real.
    const error = await captureError(() =>
      t.mutation(internal.functions.grants.createGrant, {
        workspaceId,
        userId: stranger,
        clientId: "never-registered",
        scopes: [],
        hashedRefreshToken: "",
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("resolveGrantByRefreshToken (internal)", () => {
  test("returns null for an unknown hash", async () => {
    const { t } = await threeClients();
    expect(
      await t.query(internal.functions.grants.resolveGrantByRefreshToken, {
        hashedRefreshToken: "hash-that-was-never-issued",
      }),
    ).toBeNull();
  });

  test("carries the workspace and the caller's role, so the gateway need not re-derive them", async () => {
    const { t, user, workspaceId } = await threeClients();
    const resolved = await t.query(
      internal.functions.grants.resolveGrantByRefreshToken,
      { hashedRefreshToken: "hash-claude" },
    );
    expect(resolved).toMatchObject({
      workspaceId,
      userId: user,
      clientId: "claude",
      role: "owner",
    });
  });
});

describe("touchGrant (internal)", () => {
  test("stamps last use on an active grant", async () => {
    const { t, user, workspaceId, claude } = await threeClients();
    await t.mutation(internal.functions.grants.touchGrant, { grantId: claude });

    const grants = await asUser(t, user).query(api.functions.grants.listGrants, {
      workspaceId,
    });
    expect(
      grants.find((g) => g.clientId === "claude")?.lastUsedAt,
    ).toBeGreaterThan(0);
  });

  test("does not resurrect a revoked grant", async () => {
    const { t, user, claude } = await threeClients();
    await asUser(t, user).mutation(api.functions.grants.revokeGrant, {
      grantId: claude,
    });
    await t.mutation(internal.functions.grants.touchGrant, { grantId: claude });

    const grant = await t.run((ctx) => ctx.db.get(claude));
    expect(grant?.status).toBe("revoked");
    expect(grant?.lastUsedAt).toBeUndefined();
  });
});
