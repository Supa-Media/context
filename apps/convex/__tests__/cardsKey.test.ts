import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, captureError, createUser, createWorkspace, errorCode, gatewayPost, setupTest } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { CARDS_CLIENT_ID } from "../functions/cardsKey";

/**
 * The card key (`functions/cardsKey.ts`): the grant the app leaves for its
 * Messages extension. The claims are that it is an ordinary grant (resolves on
 * the gateway's route, refreshes with rotation), one per phone, and only ever
 * for the person's own personal workspace.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *   The personal/owner check removed → "a shared workspace, or somebody
 *   else's, gets no key" fails.
 *   The reuse branch inserting instead of patching → "minting again on the
 *   same phone retires its old key" fails.
 */

const DEVICE = "phone-0000-aaaa";

async function mint(t: ReturnType<typeof setupTest>, userId: Parameters<typeof asUser>[1], workspaceId: string, deviceId = DEVICE) {
  return await asUser(t, userId).action(api.functions.cardsKey.mintCardsKey, { workspaceId: workspaceId as never, deviceId });
}

async function resolves(t: ReturnType<typeof setupTest>, accessToken: string): Promise<boolean> {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  return (JSON.parse(await response.text()) as { session: unknown }).session !== null;
}

async function rotate(t: ReturnType<typeof setupTest>, refreshToken: string, next: string) {
  const response = await gatewayPost(t, "/gateway/grants/rotate", {
    refreshToken,
    clientId: CARDS_CLIENT_ID,
    newHashedRefreshToken: await hashToken(`crt_${next}`),
    newHashedAccessToken: await hashToken(`cat_${next}`),
    accessTokenExpiresAt: Date.now() + 3_600_000,
    scopes: null,
  });
  return (JSON.parse(await response.text()) as { grant: unknown }).grant;
}

describe("the card key", () => {
  test("its owner gets a read key the gateway resolves and the extension can refresh", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    const key = await mint(t, ownerId, workspaceId);
    expect(key.clientId).toBe(CARDS_CLIENT_ID);
    expect(key.accessToken).toMatch(/^cat_[0-9a-f]{64}$/);
    expect(key.refreshToken).toMatch(/^crt_[0-9a-f]{64}$/);
    expect(key.scopes).not.toContain("context:write");
    expect(await resolves(t, key.accessToken)).toBe(true);

    expect(await rotate(t, key.refreshToken, "a".repeat(64))).not.toBeNull();
    expect(await resolves(t, key.accessToken)).toBe(false);
    expect(await resolves(t, `cat_${"a".repeat(64)}`)).toBe(true);
    // The retired refresh token, presented again, is a leak: the whole key goes.
    expect(await rotate(t, key.refreshToken, "b".repeat(64))).toBeNull();
    expect(await resolves(t, `cat_${"a".repeat(64)}`)).toBe(false);
  });

  test("minting again on the same phone retires its old key; another phone keeps its own", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    const first = await mint(t, ownerId, workspaceId);
    const other = await mint(t, ownerId, workspaceId, "phone-1111-bbbb");
    const second = await mint(t, ownerId, workspaceId);
    expect(await resolves(t, first.accessToken)).toBe(false);
    expect(await rotate(t, first.refreshToken, "c".repeat(64))).toBeNull();
    expect(await resolves(t, second.accessToken)).toBe(true);
    expect(await resolves(t, other.accessToken)).toBe(true);
  });

  test("a shared workspace, or somebody else's, gets no key", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const otherId = await createUser(t, "other@example.invalid");
    const shared = await createWorkspace(t, ownerId, "acme-proj", { kind: "shared" });
    const personal = await createWorkspace(t, ownerId, "seyi");
    await addMember(t, shared, otherId, "editor");
    expect(errorCode(await captureError(() => mint(t, ownerId, shared)))).toBe("NOT_PERSONAL");
    expect(errorCode(await captureError(() => mint(t, otherId, shared)))).toBe("NOT_PERSONAL");
    expect(errorCode(await captureError(() => mint(t, otherId, personal)))).not.toBeUndefined();
  });

  test("a device id that is not one is refused", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    for (const deviceId of ["", "short", "has spaces in it", "x".repeat(65)]) {
      expect(errorCode(await captureError(() => mint(t, ownerId, workspaceId, deviceId)))).toBe("INVALID_ARGUMENT");
    }
  });
});
