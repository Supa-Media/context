import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { decryptSecret, encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { boundWorkspace } from "./fixtures.helpers";

/**
 * Key rotation reaches connectors (`lib/storage/rekeyConnectorSecrets.ts`): a
 * connected app's tokens, sealed to their workspace, and the client secret an
 * app's authorization server issued Context, sealed to the platform. Neither
 * table is one `storageBindings` covers, so each needs its own walk.
 *
 * Sabotage: drop the connector walk from `credentialOpening.ts` and both
 * envelopes stay on the retired key; this test fails.
 */

const SECOND_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";

async function withEnv(overrides: Record<string, string | undefined>, body: () => Promise<void>) {
  const before: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    before[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("rotating the encryption key", () => {
  test("a connected app's tokens and a registered client's secret are moved forward", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const originalKey = process.env.STORAGE_SECRET_ENCRYPTION_KEY!;
    const workspace = { workspaceId: workspaceId as string };
    const platform = { platform: "integration" as const };
    const now = Date.now();
    const accessBefore = await encryptSecret("lin-access", requireKeyset(), workspace);
    const refreshBefore = await encryptSecret("lin-refresh", requireKeyset(), workspace);
    const secretBefore = await encryptSecret("client-secret", requireKeyset(), platform);

    const connectionId = await t.run((ctx) =>
      ctx.db.insert("providerConnections", {
        provider: "linear",
        workspaceId,
        scope: "personal",
        connectedBy: owner,
        encryptedAccessToken: accessBefore,
        encryptedRefreshToken: refreshBefore,
        grantedScopes: [],
        externalAccountId: "linear",
        externalTeamId: "linear",
        externalTeamName: "Linear",
        connectedAt: now,
        updatedAt: now,
      }),
    );
    const clientId = await t.run((ctx) =>
      ctx.db.insert("providerOAuthClients", {
        provider: "linear",
        redirectUri: "https://app.context.invalid/connect/linear",
        clientId: "dcr-client-1",
        encryptedClientSecret: secretBefore,
        authorizationEndpoint: "https://mcp.linear.app/authorize",
        tokenEndpoint: "https://mcp.linear.app/token",
        registeredAt: now,
      }),
    );

    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: originalKey,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: "k1",
      },
      async () => {
        const result = await t.action(internal.functions.storage.rekeyStorageBindings, {});
        expect(result).toMatchObject({ connectorSecretsRekeyed: 3, connectorSecretsSkipped: 0, connectorSecretsUnreadable: 0 });
        expect(await t.action(internal.functions.storage.rekeyStorageBindings, {})).toMatchObject({ connectorSecretsRekeyed: 0 });
      },
    );

    // Opens with the new key alone, the state a finished rotation leaves.
    await withEnv(
      {
        STORAGE_SECRET_ENCRYPTION_KEY: SECOND_KEY,
        STORAGE_SECRET_ENCRYPTION_KEY_ID: "k2",
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS: undefined,
        STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID: undefined,
      },
      async () => {
        const connection = await t.run((ctx) => ctx.db.get(connectionId));
        const client = await t.run((ctx) => ctx.db.get(clientId));
        expect(await decryptSecret(connection!.encryptedAccessToken, requireKeyset(), workspace)).toBe("lin-access");
        expect(await decryptSecret(connection!.encryptedRefreshToken!, requireKeyset(), workspace)).toBe("lin-refresh");
        expect(await decryptSecret(client!.encryptedClientSecret!, requireKeyset(), platform)).toBe("client-secret");
      },
    );
  });
});
