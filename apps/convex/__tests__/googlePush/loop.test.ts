import { beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import {
  MINUTE,
  enableMailSync,
  endToEnd,
  googleAndBucket,
  patchConnection,
  readConnection,
  runPass,
  scenario,
  sweep,
} from "../googleSyncLoop/fixtures.helpers";

/**
 * A notification makes a connection due sooner and nothing else: the pass
 * that follows is claimed by the ordinary sweep, picks the product Google
 * named, and clears only the notifications it covered.
 */
describe("push feeds the forward sync loop", () => {
  beforeEach(() => enableMailSync());

  test("a pending product is due before its interval, and the sweep claims it", async () => {
    const { t, connectionId } = await scenario();
    const now = Date.now();
    await patchConnection(t, connectionId, {
      syncIntervalMinutes: 60,
      lastSyncAt: now - MINUTE,
      nextSyncAt: now + 59 * MINUTE,
      gmail: { ...(await readConnection(t, connectionId)).gmail!, lastSyncedAt: now - MINUTE },
    });
    expect((await sweep(t)).started).toBe(0);

    await t.mutation(internal.functions.googlePush.pokeFromPubsub, { gmailAddress: "nobody@example.invalid" });
    expect((await sweep(t)).started).toBe(0);

    await patchConnection(t, connectionId, {
      push: { gmail: { address: "person@example.invalid" } },
    });
    await t.mutation(internal.functions.googlePush.pokeFromPubsub, { gmailAddress: "person@example.invalid" });
    // Pulled forward to the gap after the last pass, not to now.
    const poked = await readConnection(t, connectionId);
    expect(poked.nextSyncAt).toBeLessThanOrEqual(now + MINUTE);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now + MINUTE);
    expect((await sweep(t)).started).toBe(1);
  });

  test("the job runs the product Google named, not the least recently synced one", async () => {
    const { t, workspaceId, connectionId } = await scenario();
    const row = await readConnection(t, connectionId);
    await patchConnection(t, connectionId, {
      products: ["gmail", "chat"],
      gmail: { ...row.gmail!, lastSyncedAt: Date.now() - 10 * MINUTE },
      chat: { scopes: [], nonceSeed: "fixture-nonce", lastSyncedAt: Date.now() - 20 * MINUTE },
      push: { pending: { gmail: Date.now() } },
    });
    const job = await t.query(internal.functions.googleSync.googleForwardSyncJob, { workspaceId, connectionId });
    expect(job).toMatchObject({ kind: "run", product: "gmail" });

    await patchConnection(t, connectionId, { push: {} });
    const unpushed = await t.query(internal.functions.googleSync.googleForwardSyncJob, { workspaceId, connectionId });
    expect(unpushed).toMatchObject({ kind: "run", product: "chat" });
  });

  test("a pass clears what it covered and keeps what arrived while it ran", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const claimedAt = (await readConnection(t, connectionId)).syncStartedAt!;
    await patchConnection(t, connectionId, {
      push: { pending: { gmail: claimedAt - 1000 } },
    });
    vi.stubGlobal("fetch", googleAndBucket({ backend, history: { messageIds: [], historyId: "1100" } }).fetchImpl);
    await runPass(t, workspaceId, connectionId);
    const covered = await readConnection(t, connectionId);
    expect(covered.push?.pending).toBeUndefined();
    expect(covered.nextSyncAt).toBeGreaterThan(Date.now() + MINUTE);

    // A notification that lands after the claim is not covered by that pass.
    const reclaimed = Date.now();
    await patchConnection(t, connectionId, {
      syncStartedAt: reclaimed,
      push: { pending: { gmail: reclaimed + 1000 } },
    });
    vi.stubGlobal("fetch", googleAndBucket({ backend, history: { messageIds: [], historyId: "1200" } }).fetchImpl);
    await runPass(t, workspaceId, connectionId);
    const kept = await readConnection(t, connectionId);
    expect(kept.push?.pending?.gmail).toBe(reclaimed + 1000);
    expect(kept.nextSyncAt).toBeLessThanOrEqual(Date.now() + MINUTE);
  });

  test("disconnecting forgets every watch, so no notification finds the account", async () => {
    const { t, connectionId } = await scenario();
    await patchConnection(t, connectionId, {
      push: { gmail: { address: "person@example.invalid" }, pending: { gmail: Date.now() } },
    });
    const { asUser } = await import("../fixtures.helpers");
    const { api } = await import("../../_generated/api");
    const row = await readConnection(t, connectionId);
    await asUser(t, row.boundBy).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId: row.workspaceId,
      connectionId,
    });
    expect((await readConnection(t, connectionId)).push).toBeUndefined();
  });
});
