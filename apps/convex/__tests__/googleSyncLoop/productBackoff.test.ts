import { beforeEach, describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import {
  MINUTE,
  enableMailSync,
  patchConnection,
  readConnection,
  scenario,
  sweep,
} from "./fixtures.helpers";

/**
 * Google rate-limiting one product is that product's to wait out
 * (2026-10-18). It used to mark the whole account failed, so the card read
 * "Stopped" and Calendar and Chat waited on Gmail's backoff.
 *
 * SABOTAGE RECORD
 *   transient failures fall through to the account branch     -> 4 tests failed
 *   nextProductToSync ignores `retryAt`                       -> 2 tests failed
 *   isDue ignores an all-products backoff                     -> 1 test failed
 *   markPushPending ignores the product's backoff             -> 1 test failed
 */
describe("a product Google rate-limited backs off on its own", () => {
  beforeEach(() => enableMailSync());

  async function gmailAndChat() {
    const s = await scenario();
    const row = await readConnection(s.t, s.connectionId);
    await patchConnection(s.t, s.connectionId, {
      products: ["gmail", "chat"],
      gmail: { ...row.gmail!, lastSyncedAt: Date.now() - 20 * MINUTE },
      chat: { scopes: [], nonceSeed: "fixture-nonce", lastSyncedAt: Date.now() - 10 * MINUTE },
      syncStartedAt: Date.now(),
    });
    return s;
  }

  async function rateLimitGmail(s: Awaited<ReturnType<typeof scenario>>) {
    await s.t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId: s.connectionId,
      product: "gmail",
      status: "failed",
      errorCode: "GOOGLE_RATE_LIMITED",
      error: "Google rate-limited this mailbox. The next scheduled pass will try again.",
    });
    return await readConnection(s.t, s.connectionId);
  }

  test("the account stays healthy and only the product carries the failure", async () => {
    const s = await gmailAndChat();
    const row = await rateLimitGmail(s);
    expect(row.health).not.toBe("error");
    expect(row.errorCode).toBeUndefined();
    expect(row.lastError).toBeUndefined();
    expect(row.syncFailures).toBeUndefined();
    expect(row.gmail?.lastFailureCode).toBe("GOOGLE_RATE_LIMITED");
    expect(row.gmail?.failures).toBe(1);
    expect(row.gmail?.retryAt).toBeGreaterThanOrEqual(Date.now() + 15 * MINUTE);
    // Chat is not made to wait out Gmail's ladder.
    expect(row.nextSyncAt).toBeLessThan(row.gmail!.retryAt!);
  });

  test("the next pass goes to the sibling, even with Gmail pushed", async () => {
    const s = await gmailAndChat();
    await rateLimitGmail(s);
    await patchConnection(s.t, s.connectionId, { push: { pending: { gmail: Date.now() } } });
    const job = await s.t.query(internal.functions.googleSync.googleForwardSyncJob, {
      workspaceId: s.workspaceId,
      connectionId: s.connectionId,
    });
    expect(job).toMatchObject({ kind: "run", product: "chat" });
  });

  test("a notification for a product in backoff does not pull the next pass forward", async () => {
    const s = await gmailAndChat();
    const before = await rateLimitGmail(s);
    await patchConnection(s.t, s.connectionId, { push: { gmail: { address: "person@example.invalid" } } });
    await s.t.mutation(internal.functions.googlePush.pokeFromPubsub, { gmailAddress: "person@example.invalid" });
    const after = await readConnection(s.t, s.connectionId);
    expect(after.nextSyncAt).toBe(before.nextSyncAt);
    expect(after.push?.pending?.gmail).toBeDefined();
  });

  test("an account whose only product is backing off is not due, and its row waits for the retry", async () => {
    const s = await scenario();
    await patchConnection(s.t, s.connectionId, { syncStartedAt: Date.now() });
    const row = await rateLimitGmail(s);
    expect(row.nextSyncAt).toBe(row.gmail!.retryAt);
    await patchConnection(s.t, s.connectionId, { nextSyncAt: Date.now() - 1 });
    expect((await sweep(s.t)).started).toBe(0);
    const job = await s.t.query(internal.functions.googleSync.googleForwardSyncJob, {
      workspaceId: s.workspaceId,
      connectionId: s.connectionId,
    });
    expect(job).toEqual({ kind: "skip", reason: "GOOGLE_PRODUCT_BACKOFF" });
  });

  test("a second failure climbs the ladder, and a success clears it", async () => {
    const s = await gmailAndChat();
    const first = await rateLimitGmail(s);
    await patchConnection(s.t, s.connectionId, { syncStartedAt: Date.now() });
    const second = await rateLimitGmail(s);
    expect(second.gmail?.failures).toBe(2);
    expect(second.gmail!.retryAt! - second.gmail!.lastAttemptAt!).toBeGreaterThan(
      first.gmail!.retryAt! - first.gmail!.lastAttemptAt!,
    );
    await s.t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId: s.connectionId,
      product: "gmail",
      status: "synced",
      historyId: "900",
    });
    const healed = await readConnection(s.t, s.connectionId);
    expect(healed.gmail?.retryAt).toBeUndefined();
    expect(healed.gmail?.failures).toBeUndefined();
    expect(healed.gmail?.lastFailure).toBeUndefined();
  });

  test("a failure a person must fix still fails the account", async () => {
    const s = await gmailAndChat();
    await s.t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId: s.connectionId,
      product: "gmail",
      status: "failed",
      errorCode: "GOOGLE_ACCESS_REFUSED",
      error: "Google refused access to this mailbox.",
    });
    const row = await readConnection(s.t, s.connectionId);
    expect(row.health).toBe("error");
    expect(row.errorCode).toBe("GOOGLE_ACCESS_REFUSED");
    expect(row.gmail?.retryAt).toBeUndefined();
  });
});
