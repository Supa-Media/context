import { beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { TestConvex } from "../fixtures.helpers";
import {
  enableMailSync,
  endToEnd,
  googleAndBucket,
  jsonResponse as json,
  patchConnection,
  readConnection,
  runPass,
  tokenOk,
  withoutCachedToken,
  withTokenEndpoint,
} from "./fixtures.helpers";

/*
  ONE `invalid_grant` MUST NOT STOP A MAILBOX FOREVER.

  A row marked `reconnect_required` was skipped until a fresh connect, so a
  single spurious refusal from Google's token endpoint stopped email until its
  owner noticed. `functions/googleReconnect.ts` gives each such row one
  refresh a day; `docs/decisions/communications/sync-recovery.md`,
  "Recovering without the owner".
*/

beforeEach(() => enableMailSync());

describe("a revoked grant found by a pass", () => {
  test("only invalid_grant asks for a reconnect", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    await withoutCachedToken(t, connectionId);
    const google = withTokenEndpoint(googleAndBucket({ backend }).fetchImpl, () =>
      json({ error: "invalid_grant" }, 400),
    );
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "failed", errorCode: "GOOGLE_RECONNECT_REQUIRED" });
    const row = await readConnection(t, connectionId);
    expect(row.health).toBe("reconnect_required");
    // The cause survives the failed pass, so the daily re-check can find it.
    // Sabotage: write `args.errorCode` over it again in `recordGoogleForwardSyncPass`.
    expect(row.errorCode).toBe("GRANT_REVOKED");

    vi.stubGlobal("fetch", withTokenEndpoint(googleAndBucket({ backend }).fetchImpl, tokenOk).fetchImpl);
    await t.action(internal.functions.googleReconnect.recheckRevokedGrants, {});
    expect((await readConnection(t, connectionId)).health).toBe("active");
  });

  test("a row an older pass left as GOOGLE_RECONNECT_REQUIRED is re-checked too", async () => {
    const { t, connectionId, backend } = await endToEnd({ historyId: "1000" });
    await patchConnection(t, connectionId, { health: "reconnect_required", errorCode: "GOOGLE_RECONNECT_REQUIRED" });
    vi.stubGlobal("fetch", withTokenEndpoint(googleAndBucket({ backend }).fetchImpl, tokenOk).fetchImpl);
    await t.action(internal.functions.googleReconnect.recheckRevokedGrants, {});
    expect((await readConnection(t, connectionId)).health).toBe("active");
  });
});

describe("a reconnect Google no longer needs is cleared without the owner", () => {
  async function revoked(patch: Record<string, unknown> = {}) {
    const fixture = await endToEnd({ historyId: "1000" });
    await patchConnection(fixture.t, fixture.connectionId, {
      health: "reconnect_required",
      errorCode: "GRANT_REVOKED",
      lastError: "Google no longer accepts this authorization. Reconnect to continue.",
      syncStartedAt: undefined,
      nextSyncAt: Date.now() + 60 * 60_000,
      ...patch,
    });
    return fixture;
  }

  const recheck = (t: TestConvex) => t.action(internal.functions.googleReconnect.recheckRevokedGrants, {});

  /*
    Sabotage: return early from `recheckRevokedGrants`, or drop the
    `GRANT_REVOKED` branch of `cacheAccessTokenHandler`, and the row stays
    `reconnect_required` forever.
  */
  test("one refresh that works puts the account back in the loop", async () => {
    const { t, connectionId, workspaceId, backend } = await revoked();
    const google = withTokenEndpoint(googleAndBucket({ backend }).fetchImpl, tokenOk);
    vi.stubGlobal("fetch", google.fetchImpl);

    await recheck(t);

    // A refresh, even with a cached token still good: only a refresh proves the grant.
    expect(google.calls.token).toBe(1);
    const row = await readConnection(t, connectionId);
    expect(row.health).toBe("active");
    expect(row.errorCode).toBeUndefined();
    expect(row.lastError).toBeUndefined();
    expect(row.nextSyncAt).toBeLessThanOrEqual(Date.now());

    await patchConnection(t, connectionId, { syncStartedAt: Date.now() });
    expect(await runPass(t, workspaceId, connectionId)).toMatchObject({ status: "synced" });
  });

  test.each([
    ["invalid_grant again", () => json({ error: "invalid_grant" }, 400)],
    ["Google unavailable", () => json({ error: "backend_error" }, 503)],
  ])("%s leaves it waiting for tomorrow's check", async (_, answer) => {
    const { t, connectionId, backend } = await revoked();
    const google = withTokenEndpoint(googleAndBucket({ backend }).fetchImpl, answer);
    vi.stubGlobal("fetch", google.fetchImpl);

    await recheck(t);

    expect(google.calls.token).toBe(1);
    expect((await readConnection(t, connectionId)).health).toBe("reconnect_required");
  });

  /*
    A grant that no longer covers a product needs the person: only they can
    approve a new permission. Sabotage: drop the `errorCode` filter from
    `revokedGrantCandidates` and the token endpoint is called for it.
  */
  test("a missing permission and a disconnect are left to the person", async () => {
    const missing = await revoked({ errorCode: "SCOPES_INCOMPLETE" });
    const google = withTokenEndpoint(googleAndBucket({ backend: missing.backend }).fetchImpl, tokenOk);
    vi.stubGlobal("fetch", google.fetchImpl);
    await recheck(missing.t);
    expect(google.calls.token).toBe(0);
    expect((await readConnection(missing.t, missing.connectionId)).health).toBe("reconnect_required");

    const gone = await revoked({ disconnectedAt: Date.now() });
    const again = withTokenEndpoint(googleAndBucket({ backend: gone.backend }).fetchImpl, tokenOk);
    vi.stubGlobal("fetch", again.fetchImpl);
    await recheck(gone.t);
    expect(again.calls.token).toBe(0);
    expect((await readConnection(gone.t, gone.connectionId)).health).toBe("reconnect_required");
  });
});
