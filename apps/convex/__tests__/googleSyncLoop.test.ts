/**
 * THE FORWARD SYNC LOOP: who it polls, how often, and what it refuses.
 *
 * Every control in `functions/googleSync.ts` could be deleted with the rest of
 * this suite green unless a test names the sabotage it catches, so each
 * describe block below is one such name:
 *
 *  - the sweep starts a pass only for connections that are **due**, and never
 *    for a disconnected one, one with nothing this engine can sync, or one
 *    whose pass is still running;
 *  - the five-minute floor is refused **server-side**, not merely absent from
 *    a picker;
 *  - only the owner of a personal context may change the interval, and an
 *    owner of a *different* context cannot tell "not yours" from "no such
 *    connection" — proved with attacker and victim in ONE database, because
 *    two databases would make the refusal come from the row not existing;
 *  - the cursor advances over mail that was written and **not** over mail that
 *    was not;
 *  - a connection that has never synced does not look like one syncing fine.
 *
 * The end-to-end block drives the real `runFileOperation` — the credential
 * barrier — against a fixture Gmail and an in-memory S3, so the pass under
 * test is the pass that ships, including `gmailSync.js`'s own rendering.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedGoogleConnection,
  setupTest,
  FAKE_STORAGE,
  type TestConvex,
} from "./fixtures.helpers";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import {
  DEFAULT_SYNC_INTERVAL_MINUTES,
  MAX_SYNC_INTERVAL_MINUTES,
  MIN_SYNC_INTERVAL_MINUTES,
  SYNC_FAILURE_BACKOFF_MS,
  SYNC_STALL_MS,
} from "../functions/lib/googleSchedule";

const MINUTE = 60_000;

function enableMailSync() {
  vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

interface Scenario {
  t: TestConvex;
  owner: Id<"users">;
  workspaceId: Id<"workspaces">;
  connectionId: Id<"googleConnections">;
}

async function scenario(): Promise<Scenario> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  const connectionId = await seedGoogleConnection(t, { workspaceId, boundBy: owner });
  return { t, owner, workspaceId, connectionId };
}

/** Patch the connection row directly — the states a sweep meets, without a pass to reach them. */
async function patchConnection(
  t: TestConvex,
  connectionId: Id<"googleConnections">,
  patch: Record<string, unknown>,
): Promise<void> {
  await t.run((ctx) => ctx.db.patch(connectionId, patch));
}

async function readConnection(t: TestConvex, connectionId: Id<"googleConnections">) {
  const row = await t.run((ctx) => ctx.db.get(connectionId));
  if (row === null) throw new Error("connection vanished");
  return row;
}

async function sweep(t: TestConvex): Promise<{ started: number; examined: number }> {
  return await t.mutation(internal.functions.googleSync.sweepDueGoogleSyncs, {});
}

/* -------------------------------------------------------------------------- */

describe("the sweep starts a pass only for a connection that is due", () => {
  beforeEach(() => enableMailSync());

  test("a connection that has never synced is due at once", async () => {
    const { t, connectionId } = await scenario();
    expect(await sweep(t)).toEqual({ started: 1, examined: 1 });
    const row = await readConnection(t, connectionId);
    expect(row.syncStartedAt).toBeTypeOf("number");
    // Claimed, so the next tick five minutes from now finds it not due even
    // if this pass never reports.
    expect(row.nextSyncAt).toBeGreaterThan(Date.now());
  });

  test("...and one whose interval has not elapsed is left alone", async () => {
    const { t, connectionId } = await scenario();
    const now = Date.now();
    await patchConnection(t, connectionId, {
      syncIntervalMinutes: 15,
      lastSyncAt: now - 5 * MINUTE,
      nextSyncAt: now + 10 * MINUTE,
    });
    expect((await sweep(t)).started).toBe(0);
    expect((await readConnection(t, connectionId)).syncStartedAt).toBeUndefined();
  });

  test("...and one whose interval HAS elapsed is started", async () => {
    const { t, connectionId } = await scenario();
    const now = Date.now();
    await patchConnection(t, connectionId, {
      syncIntervalMinutes: 15,
      lastSyncAt: now - 16 * MINUTE,
      nextSyncAt: now - MINUTE,
    });
    expect((await sweep(t)).started).toBe(1);
  });

  test("the due rule is lastSyncAt plus the interval, not a stale nextSyncAt", async () => {
    const { t, connectionId } = await scenario();
    const now = Date.now();
    // `nextSyncAt` says due; the two facts it is computed from say otherwise —
    // a row left behind by a longer interval being written to it. The
    // materialized copy must not be able to out-vote them.
    await patchConnection(t, connectionId, {
      syncIntervalMinutes: 60,
      lastSyncAt: now - 10 * MINUTE,
      nextSyncAt: now - MINUTE,
    });
    expect((await sweep(t)).started).toBe(0);
  });

  test("a disconnected connection is never started, however overdue it looks", async () => {
    const { t, connectionId } = await scenario();
    const now = Date.now();
    await patchConnection(t, connectionId, {
      disconnectedAt: now,
      lastSyncAt: now - 10 * 60 * MINUTE,
      nextSyncAt: now - 10 * 60 * MINUTE,
    });
    expect(await sweep(t)).toEqual({ started: 0, examined: 0 });
    expect((await readConnection(t, connectionId)).syncStartedAt).toBeUndefined();
  });

  test("a connection with no product this engine can advance is not started", async () => {
    const { t, connectionId } = await scenario();
    await patchConnection(t, connectionId, { products: ["calendar"] });
    expect((await sweep(t)).started).toBe(0);
  });

  test("a pass that is still running is not overtaken", async () => {
    const { t, connectionId } = await scenario();
    const now = Date.now();
    await patchConnection(t, connectionId, {
      lastSyncAt: now - 60 * MINUTE,
      nextSyncAt: now - 30 * MINUTE,
      syncStartedAt: now - MINUTE,
    });
    expect((await sweep(t)).started).toBe(0);
  });

  test("...but one that has been silent for fifteen minutes is presumed lost and restarted", async () => {
    const { t, connectionId } = await scenario();
    const now = Date.now();
    await patchConnection(t, connectionId, {
      lastSyncAt: now - 60 * MINUTE,
      nextSyncAt: now - 30 * MINUTE,
      syncStartedAt: now - SYNC_STALL_MS - MINUTE,
    });
    expect((await sweep(t)).started).toBe(1);
  });

  test("a deployment where Google mail is not enabled sweeps nothing", async () => {
    const { t, connectionId } = await scenario();
    vi.stubEnv("MAIL_CONNECT_ENABLED", "");
    expect(await sweep(t)).toEqual({ started: 0, examined: 0 });
    expect((await readConnection(t, connectionId)).syncStartedAt).toBeUndefined();
  });

  test("one sweep claims a bounded batch, and the rest drain on later runs", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    for (let index = 0; index < 60; index += 1) {
      await seedGoogleConnection(t, {
        workspaceId,
        boundBy: owner,
        address: `person-${index}@example.invalid`,
      });
    }
    const first = await sweep(t);
    expect(first.started).toBe(50);
    // The claimed fifty are no longer due, so the second run reaches the rest.
    expect((await sweep(t)).started).toBe(10);
  });
});

describe("the five-minute floor is enforced server-side", () => {
  beforeEach(() => enableMailSync());

  test("four minutes is refused", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
        workspaceId,
        connectionId,
        syncIntervalMinutes: 4,
      }),
    );
    expect(errorCode(error)).toBe("GOOGLE_SYNC_INTERVAL_TOO_SHORT");
    expect((await readConnection(t, connectionId)).syncIntervalMinutes).toBeUndefined();
  });

  test("zero and a negative number are refused the same way", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    for (const minutes of [0, -5]) {
      const error = await captureError(() =>
        asUser(t, owner).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
          workspaceId,
          connectionId,
          syncIntervalMinutes: minutes,
        }),
      );
      expect(errorCode(error)).toBe("GOOGLE_SYNC_INTERVAL_TOO_SHORT");
    }
  });

  test("a fractional interval is refused rather than rounded", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
        workspaceId,
        connectionId,
        syncIntervalMinutes: 5.5,
      }),
    );
    expect(errorCode(error)).toBe("GOOGLE_SYNC_INTERVAL_INVALID");
  });

  test("longer than a day is refused, because Gmail expires a cursor in about a week", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
        workspaceId,
        connectionId,
        syncIntervalMinutes: MAX_SYNC_INTERVAL_MINUTES + 1,
      }),
    );
    expect(errorCode(error)).toBe("GOOGLE_SYNC_INTERVAL_TOO_LONG");
  });

  test("the floor itself is accepted", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    await asUser(t, owner).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
      workspaceId,
      connectionId,
      syncIntervalMinutes: MIN_SYNC_INTERVAL_MINUTES,
    });
    expect((await readConnection(t, connectionId)).syncIntervalMinutes).toBe(
      MIN_SYNC_INTERVAL_MINUTES,
    );
  });

  test("a connection nobody has chosen an interval for is polled at the default", async () => {
    const { t, connectionId } = await scenario();
    const now = Date.now();
    await patchConnection(t, connectionId, {
      lastSyncAt: now - (DEFAULT_SYNC_INTERVAL_MINUTES - 2) * MINUTE,
      nextSyncAt: now - MINUTE,
    });
    expect((await sweep(t)).started).toBe(0);
    await patchConnection(t, connectionId, {
      lastSyncAt: now - (DEFAULT_SYNC_INTERVAL_MINUTES + 1) * MINUTE,
    });
    expect((await sweep(t)).started).toBe(1);
  });

  test("shortening the interval brings the next pass forward without waiting out the old one", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    const lastSyncAt = Date.now() - 10 * MINUTE;
    await patchConnection(t, connectionId, {
      syncIntervalMinutes: 60,
      lastSyncAt,
      nextSyncAt: lastSyncAt + 60 * MINUTE,
    });
    expect((await sweep(t)).started).toBe(0);

    await asUser(t, owner).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
      workspaceId,
      connectionId,
      syncIntervalMinutes: 5,
    });
    expect((await readConnection(t, connectionId)).nextSyncAt).toBe(lastSyncAt + 5 * MINUTE);
    expect((await sweep(t)).started).toBe(1);
  });
});

describe("only this context's owner may change how often it syncs", () => {
  beforeEach(() => enableMailSync());

  test("an editor of the owner's personal context cannot", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor", owner);
    const error = await captureError(() =>
      asUser(t, editor).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
        workspaceId,
        connectionId,
        syncIntervalMinutes: 5,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
    expect((await readConnection(t, connectionId)).syncIntervalMinutes).toBeUndefined();
  });

  test("a stranger with a context of their own cannot", async () => {
    const { t, workspaceId, connectionId } = await scenario();
    const stranger = await createUser(t, "stranger@example.invalid");
    await createWorkspace(t, stranger, "elsewhere");
    const error = await captureError(() =>
      asUser(t, stranger).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
        workspaceId,
        connectionId,
        syncIntervalMinutes: 5,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
  });

  /*
    ATTACKER AND VICTIM IN ONE DATABASE.

    The attacker owns a real personal context of her own, so `requirePersonalOwner`
    says yes for the workspace she names — and the connection she names is
    somebody else's, in a workspace she has never been a member of. Two separate
    databases would prove nothing here: the refusal would come from the row not
    existing.
  */
  test("an owner of another context cannot reach this connection, and learns nothing about it", async () => {
    const { t, workspaceId: victimWorkspace, connectionId: victimConnection } = await scenario();
    const attacker = await createUser(t, "attacker@example.invalid");
    const attackerWorkspace = await createWorkspace(t, attacker, "attacker");

    const throughOwnContext = await captureError(() =>
      asUser(t, attacker).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
        workspaceId: attackerWorkspace,
        connectionId: victimConnection,
        syncIntervalMinutes: MAX_SYNC_INTERVAL_MINUTES,
      }),
    );
    const throughVictimContext = await captureError(() =>
      asUser(t, attacker).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
        workspaceId: victimWorkspace,
        connectionId: victimConnection,
        syncIntervalMinutes: MAX_SYNC_INTERVAL_MINUTES,
      }),
    );

    expect(errorCode(throughOwnContext)).toBe("GOOGLE_CONNECTION_NOT_FOUND");
    expect(errorCode(throughVictimContext)).toBe("NOT_OWNER");
    // Naming a connection id that exists must answer exactly as naming one
    // that never did.
    const missing = await t.run(async (ctx) => {
      const id = await ctx.db.insert("googleConnections", {
        workspaceId: attackerWorkspace,
        provider: "google" as const,
        address: "ghost@example.invalid",
        encryptedRefreshToken: "",
        scopes: [],
        googleAccountId: "example-ghost-account",
        products: ["gmail" as const],
        health: "active" as const,
        boundBy: attacker,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    const throughMissing = await captureError(() =>
      asUser(t, attacker).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
        workspaceId: attackerWorkspace,
        connectionId: missing,
        syncIntervalMinutes: MAX_SYNC_INTERVAL_MINUTES,
      }),
    );
    expect(errorCode(throughMissing)).toBe(errorCode(throughOwnContext));
    expect((await readConnection(t, victimConnection)).syncIntervalMinutes).toBeUndefined();
    expect((await readConnection(t, victimConnection)).nextSyncAt).toBeUndefined();
  });

  test("the owner of a SHARED context cannot set one, since a mailbox never lands in one", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const shared = await createWorkspace(t, owner, "atlas-team", { kind: "shared" });
    const connectionId = await seedGoogleConnection(t, { workspaceId: shared, boundBy: owner });
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
        workspaceId: shared,
        connectionId,
        syncIntervalMinutes: 5,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
  });

  test("a disconnected account has no schedule to change", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    await patchConnection(t, connectionId, { disconnectedAt: Date.now() });
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.googleSync.updateGoogleSyncInterval, {
        workspaceId,
        connectionId,
        syncIntervalMinutes: 5,
      }),
    );
    expect(errorCode(error)).toBe("GOOGLE_CONNECTION_NOT_FOUND");
  });
});

describe("what a pass writes back onto the row", () => {
  beforeEach(() => enableMailSync());

  async function claimed(): Promise<Scenario> {
    const s = await scenario();
    await patchConnection(s.t, s.connectionId, { syncStartedAt: Date.now(), syncIntervalMinutes: 30 });
    return s;
  }

  test("a synced pass advances the cursor, releases the claim, and schedules the next one", async () => {
    const { t, connectionId } = await claimed();
    const accepted = await t.mutation(
      internal.functions.googleSync.recordGoogleForwardSyncPass,
      {
        connectionId,
        status: "synced",
        historyId: "2000",
        daysTouched: 2,
        bytesWritten: 4096,
      },
    );
    expect(accepted).toEqual({ accepted: true });
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("2000");
    expect(row.gmail?.lastSyncedAt).toBeTypeOf("number");
    expect(row.syncStartedAt).toBeUndefined();
    expect(row.syncBytesWritten).toBe(4096);
    expect(row.health).toBe("active");
    expect(row.nextSyncAt).toBe(row.lastSyncAt! + 30 * MINUTE);
  });

  test("a failed pass leaves the cursor alone, records the failure, and backs off", async () => {
    const { t, connectionId } = await claimed();
    await patchConnection(t, connectionId, {
      gmail: { ...(await readConnection(t, connectionId)).gmail!, historyId: "1000" },
    });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "failed",
      // A cursor offered by a pass that did not finish. The mutation is where
      // this is refused, not the call site: a failed pass that advanced the
      // cursor would skip whatever it could not write, permanently and
      // silently, which is the one defect in this design that loses mail.
      historyId: "2000",
      errorCode: "GOOGLE_RATE_LIMITED",
      error: "Google rate-limited this mailbox.",
    });
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("1000");
    expect(row.gmail?.lastSyncedAt).toBeUndefined();
    expect(row.health).toBe("error");
    expect(row.errorCode).toBe("GOOGLE_RATE_LIMITED");
    expect(row.lastSyncFailureCode).toBe("GOOGLE_RATE_LIMITED");
    expect(row.syncStartedAt).toBeUndefined();
    // Thirty-minute interval, fifteen-minute backoff floor: the longer wins.
    expect(row.nextSyncAt).toBe(row.lastSyncAt! + 30 * MINUTE);
  });

  test("...and a five-minute interval still waits out the failure backoff", async () => {
    const { t, connectionId } = await claimed();
    await patchConnection(t, connectionId, { syncIntervalMinutes: 5 });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "failed",
      errorCode: "GOOGLE_UNAVAILABLE",
      error: "Google did not answer reliably.",
    });
    const row = await readConnection(t, connectionId);
    expect(row.nextSyncAt).toBe(row.lastSyncAt! + SYNC_FAILURE_BACKOFF_MS);
  });

  test("the last failure survives a later success, because that is the question being asked", async () => {
    const { t, connectionId } = await claimed();
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "failed",
      errorCode: "GOOGLE_UNAVAILABLE",
      error: "Google did not answer reliably.",
    });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "synced",
      historyId: "3000",
    });
    const row = await readConnection(t, connectionId);
    expect(row.health).toBe("active");
    // Health is current; the failure is history, and history is not cleared by
    // the next good pass.
    expect(row.lastError).toBeUndefined();
    expect(row.lastSyncFailureCode).toBe("GOOGLE_UNAVAILABLE");
  });

  test("a skipped pass releases the claim and does not make an unsynced connection look synced", async () => {
    const { t, connectionId } = await claimed();
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "skipped",
      errorCode: "GOOGLE_RECONNECT_REQUIRED",
    });
    const row = await readConnection(t, connectionId);
    expect(row.syncStartedAt).toBeUndefined();
    expect(row.lastSyncAt).toBeUndefined();
    expect(row.gmail?.lastSyncedAt).toBeUndefined();
    expect(row.nextSyncAt).toBeGreaterThan(Date.now());
  });

  test("an expired cursor is re-baselined and the gap is written down, not smoothed over", async () => {
    const { t, connectionId } = await claimed();
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "synced",
      historyId: "9999",
      gapDetected: true,
    });
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("9999");
    expect(row.health).toBe("active");
    expect(row.lastSyncFailureCode).toBe("GOOGLE_SYNC_GAP");
    expect(row.lastSyncFailure).toContain("not captured");
  });

  test("a pass reporting after a disconnect changes nothing at all", async () => {
    const { t, connectionId } = await claimed();
    await patchConnection(t, connectionId, { disconnectedAt: Date.now() });
    const accepted = await t.mutation(
      internal.functions.googleSync.recordGoogleForwardSyncPass,
      { connectionId, status: "synced", historyId: "4000" },
    );
    expect(accepted).toEqual({ accepted: false });
    expect((await readConnection(t, connectionId)).gmail?.historyId).toBeUndefined();
  });
});

describe("the pass re-asks every gate before it opens a credential", () => {
  beforeEach(() => enableMailSync());

  test("a disconnected account is skipped", async () => {
    const { t, workspaceId, connectionId } = await scenario();
    await patchConnection(t, connectionId, { disconnectedAt: Date.now() });
    expect(
      await t.query(internal.functions.googleSync.googleForwardSyncJob, {
        workspaceId,
        connectionId,
      }),
    ).toEqual({ kind: "skip", reason: "GOOGLE_DISCONNECTED" });
  });

  test("a deployment that may not read mail is skipped even mid-flight", async () => {
    const { t, workspaceId, connectionId } = await scenario();
    vi.stubEnv("MAIL_CONNECT_ENABLED", "");
    expect(
      await t.query(internal.functions.googleSync.googleForwardSyncJob, {
        workspaceId,
        connectionId,
      }),
    ).toEqual({ kind: "skip", reason: "MAIL_CONNECT_DISABLED" });
  });

  test("a grant Google has already refused is skipped rather than retried at it", async () => {
    const { t, workspaceId, connectionId } = await scenario();
    await patchConnection(t, connectionId, { health: "reconnect_required" });
    expect(
      await t.query(internal.functions.googleSync.googleForwardSyncJob, {
        workspaceId,
        connectionId,
      }),
    ).toEqual({ kind: "skip", reason: "GOOGLE_RECONNECT_REQUIRED" });
  });

  test("a product turned off since the sweep looked is skipped", async () => {
    const { t, workspaceId, connectionId } = await scenario();
    await patchConnection(t, connectionId, { products: [] });
    expect(
      await t.query(internal.functions.googleSync.googleForwardSyncJob, {
        workspaceId,
        connectionId,
      }),
    ).toEqual({ kind: "skip", reason: "NO_SYNCABLE_PRODUCT" });
  });

  test("a shared context is skipped, because a mailbox never lands in one", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const shared = await createWorkspace(t, owner, "atlas-team", { kind: "shared" });
    const connectionId = await seedGoogleConnection(t, { workspaceId: shared, boundBy: owner });
    expect(
      await t.query(internal.functions.googleSync.googleForwardSyncJob, {
        workspaceId: shared,
        connectionId,
      }),
    ).toEqual({ kind: "skip", reason: "NOT_PERSONAL_CONTEXT" });
  });

  /*
    ONE CONTEXT'S MAIL MUST NEVER BE WRITTEN INTO ANOTHER'S BUCKET.

    The pass takes a `workspaceId` (whose bucket credential is opened) and a
    `connectionId` (whose mail is read). Nothing builds a mismatched pair
    today — the sweep reads both off one row — but the pair is what a tenant
    boundary is made of, and this is the only function that sees both.
    Attacker and victim are in one database: two real personal contexts, each
    with a real connection, so a refusal cannot come from the row not existing.
  */
  test("a job whose workspace does not own the connection is refused outright", async () => {
    const { t, workspaceId: victimWorkspace, connectionId: victimConnection } = await scenario();
    const attacker = await createUser(t, "attacker@example.invalid");
    const attackerWorkspace = await createWorkspace(t, attacker, "attacker");
    const attackerConnection = await seedGoogleConnection(t, {
      workspaceId: attackerWorkspace,
      boundBy: attacker,
      address: "attacker@example.invalid",
    });

    expect(
      await t.query(internal.functions.googleSync.googleForwardSyncJob, {
        workspaceId: attackerWorkspace,
        connectionId: victimConnection,
      }),
    ).toBeNull();
    // And the mirror image, so the check cannot be one-directional.
    expect(
      await t.query(internal.functions.googleSync.googleForwardSyncJob, {
        workspaceId: victimWorkspace,
        connectionId: attackerConnection,
      }),
    ).toBeNull();
    // Each still works against its own workspace, so the refusal above is the
    // pairing and not something broken about either row.
    expect(
      await t.query(internal.functions.googleSync.googleForwardSyncJob, {
        workspaceId: victimWorkspace,
        connectionId: victimConnection,
      }),
    ).toMatchObject({ kind: "run" });
  });

  test("...and a pass driven with a mismatched pair writes nothing and touches nothing", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const attacker = await createUser(t, "attacker@example.invalid");
    const attackerWorkspace = await createWorkspace(t, attacker, "attacker");
    const google = googleAndBucket({ backend });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await t.action(internal.functions.files.runFileOperation, {
      workspaceId: attackerWorkspace,
      scope: "private" as const,
      operation: { kind: "googleForwardSync" as const, connectionId },
    });

    expect(result).toMatchObject({ status: "skipped" });
    expect(google.calls).toEqual([]);
    expect(backend.requests).toEqual([]);
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("1000");
    expect(row.gmail?.lastSyncedAt).toBeUndefined();
    // The victim's own claim is untouched: another context's pass may not even
    // release it.
    expect(row.syncStartedAt).toBeTypeOf("number");
    expect(workspaceId).not.toEqual(attackerWorkspace);
  });

  test("a live connection is handed its settings and cursor, and no secret", async () => {
    const { t, workspaceId, connectionId } = await scenario();
    await patchConnection(t, connectionId, {
      gmail: { ...(await readConnection(t, connectionId)).gmail!, historyId: "1000" },
    });
    const job = await t.query(internal.functions.googleSync.googleForwardSyncJob, {
      workspaceId,
      connectionId,
    });
    expect(job).toMatchObject({
      kind: "run",
      product: "gmail",
      address: "person@example.invalid",
      mailboxSlug: "person-at-example-invalid",
      destinationFolder: "0-inbox/email/person-at-example-invalid",
      historyId: "1000",
    });
    expect(JSON.stringify(job)).not.toContain("refresh");
    expect(JSON.stringify(job)).not.toContain("example-google-refresh-token-not-real");
  });
});

describe("what the console is told, so the two states stop looking alike", () => {
  beforeEach(() => enableMailSync());

  async function listed(t: TestConvex, owner: Id<"users">, workspaceId: Id<"workspaces">) {
    const rows = await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
      workspaceId,
    });
    return rows[0]!;
  }

  test("a connection that has never synced says so, and is due now", async () => {
    const { t, owner, workspaceId } = await scenario();
    const view = await listed(t, owner, workspaceId);
    expect(view.sync).toMatchObject({
      everSynced: false,
      intervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
    });
    expect(view.sync.lastAttemptAt).toBeUndefined();
    expect(view.sync.nextDueAt).toBeUndefined();
  });

  test("...and one that has synced reports when, and when it is next due", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    await patchConnection(t, connectionId, { syncIntervalMinutes: 30, syncStartedAt: Date.now() });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "synced",
      historyId: "2000",
    });
    const view = await listed(t, owner, workspaceId);
    expect(view.sync.everSynced).toBe(true);
    expect(view.sync.intervalMinutes).toBe(30);
    expect(view.sync.nextDueAt).toBe(view.sync.lastAttemptAt! + 30 * MINUTE);
    expect(view.gmail?.lastSyncedAt).toBeTypeOf("number");
  });

  test("a pass that only ever failed is not reported as having synced", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "failed",
      errorCode: "GOOGLE_ACCESS_REFUSED",
      error: "Google refused access to this mailbox.",
    });
    const view = await listed(t, owner, workspaceId);
    expect(view.sync.everSynced).toBe(false);
    expect(view.sync.lastAttemptAt).toBeTypeOf("number");
    expect(view.sync.lastFailureCode).toBe("GOOGLE_ACCESS_REFUSED");
    expect(view.syncStatus).toBe("error");
  });

  test("the last failure is still visible after a later pass succeeded", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "failed",
      errorCode: "GOOGLE_UNAVAILABLE",
      error: "Google did not answer reliably.",
    });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "synced",
      historyId: "2100",
    });
    const view = await listed(t, owner, workspaceId);
    expect(view.syncStatus).toBe("active");
    expect(view.sync.everSynced).toBe(true);
    expect(view.sync.lastFailureCode).toBe("GOOGLE_UNAVAILABLE");
  });

  test("a disconnected account has no next due time to show", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    await patchConnection(t, connectionId, {
      lastSyncAt: Date.now(),
      nextSyncAt: Date.now() + 15 * MINUTE,
      disconnectedAt: Date.now(),
    });
    const view = await listed(t, owner, workspaceId);
    expect(view.syncStatus).toBe("disconnected");
    expect(view.sync.nextDueAt).toBeUndefined();
  });

  test("nobody but the owner sees any of it", async () => {
    const { t, owner, workspaceId } = await scenario();
    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor", owner);
    expect(
      await asUser(t, editor).query(api.functions.googleConnect.listGoogleConnections, {
        workspaceId,
      }),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                   end to end, through the credential barrier               */
/* -------------------------------------------------------------------------- */

/**
 * A Gmail that answers the three calls a forward pass makes, and an S3 that
 * holds what it writes.
 *
 * Routed by host, so the pass exercises the real `S3Store` (real SigV4, real
 * XML) and the real `gmailSync.js` at the same time. Nothing here reaches the
 * network: `edge-runtime` has no DNS and a request to anything unrouted throws.
 */
function googleAndBucket(options: {
  backend: MemoryS3;
  profileHistoryId?: string;
  history?: { messageIds: string[]; historyId: string } | { expired: true };
  messages?: { id: string; date: string; subject: string; text: string }[];
}) {
  const calls: string[] = [];
  const messages = options.messages ?? [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const base64Url = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    if (url.hostname !== "gmail.googleapis.com") {
      return await options.backend.fetchImpl(input, init);
    }
    calls.push(url.pathname);

    if (url.pathname === "/gmail/v1/users/me/profile") {
      return json({ historyId: options.profileHistoryId ?? "5000" });
    }
    if (url.pathname === "/gmail/v1/users/me/history") {
      if (options.history && "expired" in options.history) return json({ error: { code: 404 } }, 404);
      const history = options.history ?? { messageIds: [], historyId: "1000" };
      return json({
        history: history.messageIds.map((id) => ({ messagesAdded: [{ message: { id } }] })),
        historyId: history.historyId,
      });
    }
    const single = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
    if (single) {
      const message = messages.find((candidate) => candidate.id === single[1]);
      if (!message) return json({ error: { code: 404 } }, 404);
      return json({
        id: message.id,
        threadId: `thread-${message.id}`,
        internalDate: String(Date.parse(message.date)),
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: "Sender Example <sender@example.invalid>" },
            { name: "To", value: "person@example.invalid" },
            { name: "Subject", value: message.subject },
          ],
          parts: [
            { mimeType: "text/plain", body: { size: message.text.length, data: base64Url(message.text) } },
          ],
        },
      });
    }
    if (url.pathname === "/gmail/v1/users/me/messages") {
      const query = url.searchParams.get("q") ?? "";
      const after = /after:(\d+)/.exec(query);
      const before = /before:(\d+)/.exec(query);
      const from = after ? Number(after[1]) * 1000 : -Infinity;
      const to = before ? Number(before[1]) * 1000 : Infinity;
      const matching = messages.filter((message) => {
        const at = Date.parse(message.date);
        return at >= from && at < to;
      });
      return json({
        messages: matching.map((message) => ({ id: message.id, threadId: `thread-${message.id}` })),
        resultSizeEstimate: matching.length,
      });
    }
    return json({ error: { code: 404 } }, 404);
  };

  return { fetchImpl, calls };
}

async function endToEnd(options: {
  historyId?: string;
  quotaBytes?: number;
  storage?: "connected" | "missing";
} = {}) {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  const connectionId = await seedGoogleConnection(t, { workspaceId, boundBy: owner });
  const keyset = requireKeyset();

  await t.run(async (ctx) => {
    const row = (await ctx.db.get(connectionId))!;
    await ctx.db.patch(connectionId, {
      gmail: {
        ...row.gmail!,
        historyId: options.historyId,
        quotaBytes: options.quotaBytes ?? 1_000_000_000,
      },
      // A cached access token, so the pass never calls Google's token
      // endpoint: what is under test here is the sync, not the refresh.
      encryptedAccessToken: await encryptSecret("example-access-token-not-real", keyset, {
        workspaceId,
      }),
      accessTokenExpiresAt: Date.now() + 30 * MINUTE,
      syncStartedAt: Date.now(),
    });
    if (options.storage !== "missing") {
      await ctx.db.insert("storageBindings", {
        workspaceId,
        provider: FAKE_STORAGE.provider,
        endpoint: FAKE_STORAGE.endpoint,
        region: FAKE_STORAGE.region,
        bucket: FAKE_STORAGE.bucket,
        accessKeyId: FAKE_STORAGE.accessKeyId,
        encryptedSecretAccessKey: await encryptSecret(FAKE_STORAGE.secretAccessKey, keyset, {
          workspaceId,
        }),
        capabilities: { conditionalWrite: true },
        status: "connected" as const,
        lastVerifiedAt: Date.now(),
        boundBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });

  const backend = memoryS3(FAKE_STORAGE.bucket);
  return { t, owner, workspaceId, connectionId, backend };
}

async function runPass(t: TestConvex, workspaceId: Id<"workspaces">, connectionId: Id<"googleConnections">) {
  return await t.action(internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private" as const,
    operation: { kind: "googleForwardSync" as const, connectionId },
  });
}

describe("one pass, end to end, through the credential barrier", () => {
  beforeEach(() => enableMailSync());

  test("a connection with no cursor takes a baseline and fetches no mail", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd();
    const google = googleAndBucket({ backend, profileHistoryId: "7000" });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ kind: "googleForwardSync", status: "synced", daysTouched: 0 });
    expect(google.calls).toEqual(["/gmail/v1/users/me/profile"]);
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("7000");
    expect(row.syncStartedAt).toBeUndefined();
    // Forward-only: a baseline is where syncing starts, not a licence to read
    // what came before it.
    expect(Object.keys(backend.snapshot())).toEqual([]);
  });

  test("a cursor advances, and the day the mail landed on is written into the bucket", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const google = googleAndBucket({
      backend,
      history: { messageIds: ["msg-1"], historyId: "1100" },
      messages: [
        {
          id: "msg-1",
          date: "2026-09-08T09:14:00.000Z",
          subject: "Quarterly numbers",
          text: "The numbers are attached.",
        },
      ],
    });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({
      kind: "googleForwardSync",
      status: "synced",
      daysTouched: 1,
      cursorAdvanced: true,
    });
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("1100");
    expect(row.gmail?.lastSyncedAt).toBeTypeOf("number");
    expect(row.syncBytesWritten).toBeGreaterThan(0);

    const written = backend.snapshot();
    const day = "0-inbox/email/person-at-example-invalid/2026-09-08.md";
    expect(Object.keys(written)).toContain(day);
    expect(written[day]).toContain("Quarterly numbers");
  });

  test("re-running the same pass writes no new bytes and moves nothing", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const google = googleAndBucket({
      backend,
      history: { messageIds: ["msg-1"], historyId: "1100" },
      messages: [
        {
          id: "msg-1",
          date: "2026-09-08T09:14:00.000Z",
          subject: "Quarterly numbers",
          text: "The numbers are attached.",
        },
      ],
    });
    vi.stubGlobal("fetch", google.fetchImpl);

    await runPass(t, workspaceId, connectionId);
    const first = backend.snapshot();

    // Wind the cursor back and run it again. The day is rebuilt from Gmail's
    // live state either way, and `renderChannelDayNote`'s `updated` is keyed
    // to the newest message rather than to wall-clock time — so a repeated
    // pass writes the same bytes. That is the property that makes a scheduled
    // loop safe to run every five minutes forever.
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(connectionId))!;
      await ctx.db.patch(connectionId, {
        gmail: { ...row.gmail!, historyId: "1000" },
        syncStartedAt: Date.now(),
      });
    });
    await runPass(t, workspaceId, connectionId);
    expect(backend.snapshot()).toEqual(first);
  });

  test("an expired cursor re-baselines forward and records the gap", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const google = googleAndBucket({
      backend,
      history: { expired: true },
      profileHistoryId: "8000",
    });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "synced", gapDetected: true });
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("8000");
    expect(row.lastSyncFailureCode).toBe("GOOGLE_SYNC_GAP");
  });

  test("a quota ceiling stops the pass and does NOT advance the cursor past unwritten mail", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({
      historyId: "1000",
      quotaBytes: 1,
    });
    const google = googleAndBucket({
      backend,
      history: { messageIds: ["msg-1"], historyId: "1100" },
      messages: [
        {
          id: "msg-1",
          date: "2026-09-08T09:14:00.000Z",
          subject: "Quarterly numbers",
          text: "The numbers are attached.",
        },
      ],
    });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "failed", errorCode: "MAIL_QUOTA_EXCEEDED" });
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("1000");
    expect(row.errorCode).toBe("MAIL_QUOTA_EXCEEDED");
  });

  test("Gmail refusing the account is recorded as a failure a person can read", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const google = googleAndBucket({ backend });
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.hostname === "gmail.googleapis.com") {
        return new Response(JSON.stringify({ error: { code: 403, message: "denied" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return await google.fetchImpl(input, init);
    });

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "failed", errorCode: "GOOGLE_ACCESS_REFUSED" });
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("1000");
    expect(row.health).toBe("error");
    expect(row.lastSyncFailureCode).toBe("GOOGLE_ACCESS_REFUSED");
  });

  test("a context with no bucket records the failure rather than throwing into the scheduler", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({
      historyId: "1000",
      storage: "missing",
    });
    const google = googleAndBucket({ backend });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "failed", errorCode: "STORAGE_NOT_CONNECTED" });
    const row = await readConnection(t, connectionId);
    expect(row.syncStartedAt).toBeUndefined();
    // Nothing was asked of Google, because nothing could have been written.
    expect(google.calls).toEqual([]);
  });

  test("a pass that cannot mint a token records it, rather than stranding the claim", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    // No cached token to fall back on and nothing configured to mint a new
    // one. What matters is not which of the two codes comes back but that the
    // pass *reports*: a throw escaping here would leave the row claimed and
    // silent for fifteen minutes with nothing on it to explain why.
    await t.run((ctx) =>
      ctx.db.patch(connectionId, {
        encryptedAccessToken: undefined,
        accessTokenExpiresAt: undefined,
      }),
    );
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    const google = googleAndBucket({ backend });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "failed", errorCode: "GOOGLE_RECONNECT_REQUIRED" });
    const row = await readConnection(t, connectionId);
    expect(row.syncStartedAt).toBeUndefined();
    expect(row.gmail?.historyId).toBe("1000");
    expect(row.lastSyncFailureCode).toBe("GOOGLE_RECONNECT_REQUIRED");
    // The sentence shown never quotes this deployment's own configuration.
    expect(row.lastSyncFailure).not.toContain("client");
    expect(google.calls).toEqual([]);
  });

  test("a disconnected account releases its claim without touching Google or the bucket", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    await patchConnection(t, connectionId, { disconnectedAt: Date.now() });
    const google = googleAndBucket({ backend });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "skipped", errorCode: "GOOGLE_DISCONNECTED" });
    expect(google.calls).toEqual([]);
    expect(backend.requests).toEqual([]);
  });
});
