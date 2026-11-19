/**
 * A Calendar connect that gives a row a grant covering everything on it
 * clears a `reconnect_required` left by an earlier, narrower grant. Nothing
 * else clears it: the meetings claim skips a reconnect-required row and never
 * mints for it, so without this the row would stay flagged for good.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { CALENDAR_OWNED_SCOPE, IDENTITY_SCOPES } from "../../functions/lib/googleOAuth";
import { internal } from "../../_generated/api";
import { seedGoogleConnection } from "../fixtures.helpers";
import { twoConnectedTenants } from "../controlPlane/fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function calendarRowFlagged() {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
  const { t, aliceWs, alice } = await twoConnectedTenants();
  const connectionId = await seedGoogleConnection(t, { workspaceId: aliceWs, boundBy: alice, address: "alice@gmail.example" });
  await t.run((ctx) => ctx.db.patch(connectionId, { products: ["calendar"], health: "reconnect_required", errorCode: "SCOPES_INCOMPLETE" }));
  return { t, aliceWs, alice, connectionId };
}

async function bindWith(
  t: Awaited<ReturnType<typeof calendarRowFlagged>>["t"],
  workspaceId: Awaited<ReturnType<typeof calendarRowFlagged>>["aliceWs"],
  alice: Awaited<ReturnType<typeof calendarRowFlagged>>["alice"],
  scopes: string[],
) {
  const context = { workspaceId: workspaceId as string };
  return await t.mutation(internal.functions.calendarConnect.applyCalendarConnectionBinding, {
    workspaceId,
    boundBy: alice,
    address: "alice@gmail.example",
    googleAccountId: "google-alice",
    scopes: [...IDENTITY_SCOPES, ...scopes],
    encryptedRefreshToken: await encryptSecret("refresh-calendar", requireKeyset(), context),
    encryptedAccessToken: await encryptSecret("access-calendar", requireKeyset(), context),
    accessTokenExpiresAt: Date.now() + 3_600_000,
  });
}

describe("a fresh Calendar grant on a flagged row", () => {
  test("a grant covering everything on the row makes it active again", async () => {
    const { t, aliceWs, alice, connectionId } = await calendarRowFlagged();
    await bindWith(t, aliceWs, alice, [CALENDAR_OWNED_SCOPE]);
    const row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row).toMatchObject({ health: "active" });
    expect(row?.errorCode).toBeUndefined();
  });

  test("a grant that still starves the row keeps it flagged", async () => {
    const { t, aliceWs, alice, connectionId } = await calendarRowFlagged();
    await bindWith(t, aliceWs, alice, []);
    const row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row).toMatchObject({ health: "reconnect_required", errorCode: "SCOPES_INCOMPLETE" });
  });
});
