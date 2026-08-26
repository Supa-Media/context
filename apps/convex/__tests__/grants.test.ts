/**
 * Per-client grants.
 *
 * The property the whole design exists for: revoking one AI client cuts off
 * exactly that client. If revocation were coarser, "connect Context to
 * everything" would mean "one bad client costs you every client".
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import {
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
