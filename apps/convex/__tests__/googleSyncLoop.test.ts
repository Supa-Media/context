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
  MAX_SYNC_BACKOFF_MS,
  MAX_SYNC_INTERVAL_MINUTES,
  MIN_SYNC_INTERVAL_MINUTES,
  SYNC_FAILURE_BACKOFF_MS,
  SYNC_STALL_MS,
} from "../functions/lib/googleSchedule";

const MINUTE = 60_000;

function enableMailSync() {
  vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
  vi.stubEnv("CALENDAR_CONNECT_ENABLED", "true");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  test("a Calendar-only connection is started by the same account-level sweep", async () => {
    const { t, connectionId } = await scenario();
    await patchConnection(t, connectionId, {
      products: ["calendar"],
      gmail: undefined,
      calendar: {
        scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      },
    });
    expect((await sweep(t)).started).toBe(1);
  });

  test("Calendar still runs when Gmail and Chat are disabled on the deployment", async () => {
    const { t, connectionId } = await scenario();
    vi.stubEnv("MAIL_CONNECT_ENABLED", "");
    await patchConnection(t, connectionId, {
      products: ["calendar"],
      gmail: undefined,
      calendar: {
        scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      },
    });
    expect((await sweep(t)).started).toBe(1);
  });

  test("a newly-added Calendar product is due even when Gmail just finished", async () => {
    const { t, connectionId } = await scenario();
    const row = await readConnection(t, connectionId);
    const now = Date.now();
    await patchConnection(t, connectionId, {
      products: ["gmail", "calendar"],
      gmail: { ...row.gmail!, lastSyncedAt: now },
      calendar: {
        scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      },
      lastSyncAt: now,
      nextSyncAt: now,
    });

    expect((await sweep(t)).started).toBe(1);
  });

  test("a Chat-only connection is started by the same account-level sweep", async () => {
    const { t, connectionId } = await scenario();
    await patchConnection(t, connectionId, {
      products: ["chat"],
      gmail: undefined,
      chat: {
        scopes: [
          "https://www.googleapis.com/auth/chat.messages.readonly",
          "https://www.googleapis.com/auth/chat.spaces.readonly",
        ],
        nonceSeed: "fixture-chat-nonce-seed",
      },
    });

    expect((await sweep(t)).started).toBe(1);
  });

  test("a newly-added Chat product is due even when Gmail just finished", async () => {
    const { t, connectionId } = await scenario();
    const row = await readConnection(t, connectionId);
    const now = Date.now();
    await patchConnection(t, connectionId, {
      products: ["gmail", "chat"],
      gmail: { ...row.gmail!, lastSyncedAt: now },
      chat: {
        scopes: [
          "https://www.googleapis.com/auth/chat.messages.readonly",
          "https://www.googleapis.com/auth/chat.spaces.readonly",
        ],
        nonceSeed: "fixture-chat-nonce-seed",
      },
      lastSyncAt: now,
      nextSyncAt: now,
    });

    expect((await sweep(t)).started).toBe(1);
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

  test("two due accounts in one workspace are serialized before either can render shared notes", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    const siblingId = await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "sibling@example.invalid",
    });
    for (const [id, nonceSeed] of [
      [connectionId, "fixture-chat-nonce-seed-a"],
      [siblingId, "fixture-chat-nonce-seed-b"],
    ] as const) {
      await patchConnection(t, id, {
        products: ["chat"],
        gmail: undefined,
        chat: {
          scopes: [
            "https://www.googleapis.com/auth/chat.messages.readonly",
            "https://www.googleapis.com/auth/chat.spaces.readonly",
          ],
          nonceSeed,
        },
      });
    }

    expect((await sweep(t)).started).toBe(1);
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
    vi.stubEnv("CALENDAR_CONNECT_ENABLED", "");
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
    // Thirty-minute interval, fifteen-minute backoff floor: the longer wins,
    // plus this connection's own spread, so a deployment's connections do not
    // all wake in the same minute after an outage ends.
    const wait = row.nextSyncAt! - row.lastSyncAt!;
    expect(wait).toBeGreaterThanOrEqual(30 * MINUTE);
    expect(wait).toBeLessThan(31 * MINUTE);
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
    const wait = row.nextSyncAt! - row.lastSyncAt!;
    expect(wait).toBeGreaterThanOrEqual(SYNC_FAILURE_BACKOFF_MS);
    expect(wait).toBeLessThan(SYNC_FAILURE_BACKOFF_MS + MINUTE);
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

describe("a writer with nobody present still leaves a record", () => {
  beforeEach(() => enableMailSync());

  test("a pass that wrote days is audited against the person whose grant it used", async () => {
    const { t, owner, connectionId, workspaceId } = await scenario();
    await patchConnection(t, connectionId, { syncStartedAt: Date.now() });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "synced",
      historyId: "1200",
      daysTouched: 2,
      bytesWritten: 4096,
    });
    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .filter((q) => q.eq(q.field("action"), "google_sync_wrote"))
        .collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.workspaceId).toBe(workspaceId);
    // Non-negotiable #4: the acting identity, not just the scope. Nobody is
    // present, so it is the person whose grant every write was made on.
    expect(events[0]!.actorUserId).toBe(owner);
    expect(events[0]!.details).toMatchObject({ product: "gmail", days: 2, bytes: 4096 });
    // Counts only — never an address, a subject, or a path.
    const written = JSON.stringify(events[0]);
    expect(written).not.toContain("person@example.invalid");
    expect(written).not.toContain("0-inbox");
  });

  test("a poll that found nothing is not an event", async () => {
    const { t, connectionId } = await scenario();
    await patchConnection(t, connectionId, { syncStartedAt: Date.now() });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "synced",
      historyId: "1200",
      daysTouched: 0,
    });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "skipped",
      errorCode: "GOOGLE_RECONNECT_REQUIRED",
    });
    /*
      288 rows a day per connection saying "looked, nothing there" is not an
      audit trail, it is a way to lose the rows that matter inside one.
    */
    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .filter((q) => q.eq(q.field("action"), "google_sync_wrote"))
        .collect(),
    );
    expect(events).toHaveLength(0);
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

  test("a Chat-only connection is handed its state and every history-preserving contributor", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    const siblingId = await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "sibling@example.invalid",
    });
    await patchConnection(t, connectionId, {
      products: ["chat"],
      gmail: undefined,
      chat: {
        scopes: [
          "https://www.googleapis.com/auth/chat.messages.readonly",
          "https://www.googleapis.com/auth/chat.spaces.readonly",
        ],
        nonceSeed: "fixture-chat-nonce-seed-a",
        cursors: { "spaces/alpha": "2026-09-12T10:00:00.000Z" },
        spaceSettings: { "spaces/quiet": "paused" },
      },
    });
    await patchConnection(t, siblingId, {
      products: ["chat"],
      gmail: undefined,
      disconnectedAt: Date.now(),
      chat: {
        scopes: [
          "https://www.googleapis.com/auth/chat.messages.readonly",
          "https://www.googleapis.com/auth/chat.spaces.readonly",
        ],
        nonceSeed: "fixture-chat-nonce-seed-b",
        lastSyncedAt: Date.now() - MINUTE,
      },
    });

    const job = await t.query(internal.functions.googleSync.googleForwardSyncJob, {
      workspaceId,
      connectionId,
    });
    expect(job).toMatchObject({
      kind: "run",
      product: "chat",
      address: "person@example.invalid",
      destinationFolder: "2-areas/communications/daily",
      cursors: { "spaces/alpha": "2026-09-12T10:00:00.000Z" },
      spaceSettings: { "spaces/quiet": "paused" },
    });
    expect(job).toMatchObject({
      contributorSourceIds: expect.arrayContaining([connectionId, siblingId]),
    });
    expect(JSON.stringify(job)).not.toContain("refresh");
  });

  test("Chat does not wait forever on a disconnected account that never contributed", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    const historicalId = await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "history@example.invalid",
    });
    const emptyId = await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "never-synced@example.invalid",
    });
    for (const [id, disconnectedAt, lastSyncedAt] of [
      [connectionId, undefined, undefined],
      [historicalId, Date.now(), Date.now() - MINUTE],
      [emptyId, Date.now(), undefined],
    ] as const) {
      await patchConnection(t, id, {
        products: ["chat"],
        gmail: undefined,
        disconnectedAt,
        chat: {
          scopes: [
            "https://www.googleapis.com/auth/chat.messages.readonly",
            "https://www.googleapis.com/auth/chat.spaces.readonly",
          ],
          nonceSeed: `fixture-chat-nonce-seed-${id}`,
          lastSyncedAt,
        },
      });
    }

    const job = await t.query(internal.functions.googleSync.googleForwardSyncJob, {
      workspaceId,
      connectionId,
    });
    expect(job).toMatchObject({
      kind: "run",
      product: "chat",
      contributorSourceIds: expect.arrayContaining([connectionId, historicalId]),
    });
    expect((job as { contributorSourceIds: string[] }).contributorSourceIds).not.toContain(emptyId);
  });

  test("a Calendar-only connection is handed its cursor and every contributor for the destination", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    const siblingId = await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "sibling@example.invalid",
    });
    for (const id of [connectionId, siblingId]) {
      await patchConnection(t, id, {
        products: ["calendar"],
        gmail: undefined,
        calendar: {
          scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
          destinationFolder: "0-inbox/calendar",
          ...(id === connectionId ? { syncToken: "calendar-sync-token" } : {}),
        },
      });
    }

    const job = await t.query(internal.functions.googleSync.googleForwardSyncJob, {
      workspaceId,
      connectionId,
    });
    expect(job).toMatchObject({
      kind: "run",
      product: "calendar",
      address: "person@example.invalid",
      destinationFolder: "0-inbox/calendar",
      syncToken: "calendar-sync-token",
      contributorSourceIds: expect.arrayContaining([connectionId, siblingId]),
    });
    expect(JSON.stringify(job)).not.toContain("refresh");
  });

  test("Calendar keeps disconnected history without waiting forever on an account that never synced", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    const historicalId = await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "history@example.invalid",
    });
    const emptyId = await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "never-synced@example.invalid",
    });
    for (const [id, lastSyncedAt] of [
      [connectionId, undefined],
      [historicalId, Date.now() - MINUTE],
      [emptyId, undefined],
    ] as const) {
      await patchConnection(t, id, {
        products: ["calendar"],
        gmail: undefined,
        disconnectedAt: id === connectionId ? undefined : Date.now(),
        calendar: {
          scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
          destinationFolder: "0-inbox/calendar",
          lastSyncedAt,
        },
      });
    }

    const job = await t.query(internal.functions.googleSync.googleForwardSyncJob, {
      workspaceId,
      connectionId,
    });
    expect(job).toMatchObject({
      kind: "run",
      product: "calendar",
      contributorSourceIds: expect.arrayContaining([connectionId, historicalId]),
    });
    expect((job as { contributorSourceIds: string[] }).contributorSourceIds).not.toContain(emptyId);
  });
});

describe("a pass that ran out of history pages", () => {
  beforeEach(() => enableMailSync());

  test("stays due immediately rather than waiting out its interval", async () => {
    const { t, connectionId } = await scenario();
    await patchConnection(t, connectionId, { syncIntervalMinutes: 60, syncStartedAt: Date.now() });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "synced",
      historyId: "1200",
      catchUp: true,
    });
    const row = await readConnection(t, connectionId);
    // The cursor moved to the record boundary the walk actually reached, and
    // the row says there is more behind it.
    expect(row.gmail?.historyId).toBe("1200");
    expect(row.syncCatchUp).toBe(true);
    expect(row.nextSyncAt).toBeLessThanOrEqual(Date.now());
    // An hourly connection is due on the very next tick, because the interval
    // is about how often to *check* and this pass already knows there is work.
    expect((await sweep(t)).started).toBe(1);
  });

  test("...and a pass that finished clears the flag, so it is not due forever", async () => {
    const { t, connectionId } = await scenario();
    await patchConnection(t, connectionId, {
      syncIntervalMinutes: 60,
      syncCatchUp: true,
      syncStartedAt: Date.now(),
    });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "synced",
      historyId: "1300",
    });
    const row = await readConnection(t, connectionId);
    expect(row.syncCatchUp).toBeUndefined();
    expect(row.nextSyncAt).toBe(row.lastSyncAt! + 60 * MINUTE);
    expect((await sweep(t)).started).toBe(0);
  });

  test.each(["failed", "skipped"] as const)(
    "a %s catch-up pass clears the urgent flag and honors its retry time",
    async (status) => {
      const { t, connectionId } = await scenario();
      await patchConnection(t, connectionId, {
        syncIntervalMinutes: 60,
        syncCatchUp: true,
        syncStartedAt: Date.now(),
      });
      await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId,
        status,
        errorCode: status === "failed" ? "GOOGLE_UNAVAILABLE" : "GOOGLE_RECONNECT_REQUIRED",
        ...(status === "failed" ? { error: "Google did not answer reliably." } : {}),
      });
      const row = await readConnection(t, connectionId);
      expect(row.syncCatchUp).toBeUndefined();
      expect(row.nextSyncAt).toBeGreaterThan(Date.now());
      expect((await sweep(t)).started).toBe(0);
    },
  );

  test("the console says it is catching up rather than claiming it is current", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    await patchConnection(t, connectionId, { syncStartedAt: Date.now() });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "synced",
      historyId: "1200",
      catchUp: true,
    });
    const view = (
      await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
        workspaceId,
      })
    )[0]!;
    expect(view.sync.catchingUp).toBe(true);
  });
});

describe("a grant Google has refused stays refused", () => {
  beforeEach(() => enableMailSync());

  test("a failed pass does not overwrite reconnect_required with a plain error", async () => {
    const { t, connectionId } = await scenario();
    // The real sequence: minting marks the row, the pass then reports.
    await t.mutation(internal.functions.googleConnect.markReconnectRequired, { connectionId });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "failed",
      errorCode: "GOOGLE_RECONNECT_REQUIRED",
      error: "Google needs to be reconnected before this mailbox can sync.",
    });
    const row = await readConnection(t, connectionId);
    expect(row.health).toBe("reconnect_required");
    // ...which is what makes the pass's own skip gate fire on the next tick,
    // instead of asking Google for a token it has already refused, forever.
    expect(
      await t.query(internal.functions.googleSync.googleForwardSyncJob, {
        workspaceId: row.workspaceId,
        connectionId,
      }),
    ).toEqual({ kind: "skip", reason: "GOOGLE_RECONNECT_REQUIRED" });
  });

  test("an ordinary failure still moves a healthy connection to error", async () => {
    const { t, connectionId } = await scenario();
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "failed",
      errorCode: "GOOGLE_UNAVAILABLE",
      error: "Google did not answer reliably.",
    });
    expect((await readConnection(t, connectionId)).health).toBe("error");
  });

  test("repeated failures back off further each time, and a success resets the ladder", async () => {
    const { t, connectionId } = await scenario();
    await patchConnection(t, connectionId, { syncIntervalMinutes: 5 });
    const waits: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId,
        status: "failed",
        errorCode: "GOOGLE_RATE_LIMITED",
        error: "Google rate-limited this mailbox.",
      });
      const row = await readConnection(t, connectionId);
      waits.push(row.nextSyncAt! - row.lastSyncAt!);
    }
    // Strictly increasing: a connection Google is refusing is not asked again
    // every fifteen minutes forever.
    expect(waits[1]).toBeGreaterThan(waits[0]!);
    expect(waits[2]).toBeGreaterThan(waits[1]!);
    expect(waits[3]).toBeGreaterThan(waits[2]!);
    expect((await readConnection(t, connectionId)).syncFailures).toBe(4);

    await patchConnection(t, connectionId, { syncStartedAt: Date.now() });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "synced",
      historyId: "2200",
    });
    const healthy = await readConnection(t, connectionId);
    expect(healthy.syncFailures).toBeUndefined();
    expect(healthy.nextSyncAt).toBe(healthy.lastSyncAt! + 5 * MINUTE);
  });

  test("the ladder is capped, so a dead connection is still checked daily", async () => {
    const { t, connectionId } = await scenario();
    await patchConnection(t, connectionId, { syncFailures: 40 });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      status: "failed",
      errorCode: "GOOGLE_RATE_LIMITED",
      error: "Google rate-limited this mailbox.",
    });
    const row = await readConnection(t, connectionId);
    expect(row.nextSyncAt! - row.lastSyncAt!).toBeLessThanOrEqual(MAX_SYNC_BACKOFF_MS + MINUTE);
    expect(row.nextSyncAt! - row.lastSyncAt!).toBeGreaterThanOrEqual(MAX_SYNC_BACKOFF_MS);
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
  history?:
    | { messageIds: string[]; historyId: string }
    | { expired: true }
    /**
     * A paged history, one entry per page, each carrying a record id — the
     * shape that exposes whether the walk's page limit is handled. Without
     * this the fixture could never return a `nextPageToken`, and paging was
     * the part of the real client nothing exercised.
     */
    | { pages: { recordId?: string; messageIds?: string[] }[]; historyId: string };
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
      if (options.history && "pages" in options.history) {
        const index = Number(url.searchParams.get("pageToken") ?? "0");
        const page = options.history.pages[index];
        if (!page) return json({ history: [], historyId: options.history.historyId });
        const body: Record<string, unknown> = {
          history:
            page.recordId === undefined
              ? []
              : [
                  {
                    id: page.recordId,
                    messagesAdded: (page.messageIds ?? []).map((id) => ({ message: { id } })),
                  },
                ],
          // Every page carries the MAILBOX head, which is the whole trap.
          historyId: options.history.historyId,
        };
        if (index + 1 < options.history.pages.length) body.nextPageToken = String(index + 1);
        return json(body);
      }
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

function chatAndBucket(options: { backend: MemoryS3 }) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    if (url.hostname !== "chat.googleapis.com") {
      return await options.backend.fetchImpl(input, init);
    }
    calls.push(url.pathname);
    if (url.pathname === "/v1/spaces") {
      return json({
        spaces: [
          {
            name: "spaces/alpha",
            displayName: "Engineering",
            spaceType: "SPACE",
            spaceHistoryState: "HISTORY_ON",
          },
        ],
      });
    }
    if (url.pathname === "/v1/spaces/alpha/messages") {
      return json({
        messages: [
          {
            name: "spaces/alpha/messages/msg-1",
            createTime: "2026-09-12T10:00:00.000Z",
            text: "Ship the live Chat bridge",
            thread: { name: "spaces/alpha/threads/thread-1" },
            sender: { name: "users/adam", displayName: "Adam Okonkwo" },
          },
        ],
      });
    }
    return json({ error: { code: 404 } }, 404);
  };
  return { fetchImpl, calls };
}

function calendarAndBucket(options: { backend: MemoryS3 }) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    if (url.hostname !== "www.googleapis.com") {
      return await options.backend.fetchImpl(input, init);
    }
    calls.push(url.pathname);
    if (url.pathname === "/calendar/v3/calendars/primary/events") {
      return json({
        timeZone: "America/New_York",
        nextSyncToken: "calendar-token-2",
        items: [
          {
            id: "event-1",
            status: "confirmed",
            summary: "Design review",
            start: { dateTime: "2026-09-13T14:00:00.000Z" },
            end: { dateTime: "2026-09-13T14:30:00.000Z" },
          },
        ],
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

  test("a baselined connection is not reported as having synced mail", async () => {
    const { t, owner, workspaceId, connectionId, backend } = await endToEnd();
    const google = googleAndBucket({ backend, profileHistoryId: "7000" });
    vi.stubGlobal("fetch", google.fetchImpl);

    await runPass(t, workspaceId, connectionId);

    const view = (
      await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
        workspaceId,
      })
    )[0]!;
    /*
      A baseline pass reads no mail — that is what forward-only means — so it
      must not turn "connected, nothing read yet" into a card that looks
      identical to a mailbox syncing fine. It is the same defect the schedule
      block was written to close, arriving one state later.
    */
    expect(view.sync.everSynced).toBe(false);
    expect(view.sync.cursorReady).toBe(true);
    expect(view.gmail?.lastSyncedAt).toBeUndefined();

    // ...and an ordinary pass afterwards, even one that finds nothing new, is
    // a real sync: the mailbox was actually read.
    await patchConnection(t, connectionId, { syncStartedAt: Date.now() });
    const quiet = googleAndBucket({ backend, history: { messageIds: [], historyId: "7100" } });
    vi.stubGlobal("fetch", quiet.fetchImpl);
    await runPass(t, workspaceId, connectionId);
    const after = (
      await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
        workspaceId,
      })
    )[0]!;
    expect(after.sync.everSynced).toBe(true);
  });

  test("re-baselining after a gap does not invent a sync that never read anything", async () => {
    const { t, owner, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const google = googleAndBucket({ backend, history: { expired: true }, profileHistoryId: "8000" });
    vi.stubGlobal("fetch", google.fetchImpl);

    await runPass(t, workspaceId, connectionId);

    const view = (
      await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
        workspaceId,
      })
    )[0]!;
    expect(view.sync.everSynced).toBe(false);
    expect(view.sync.lastFailureCode).toBe("GOOGLE_SYNC_GAP");
  });

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

  test("a Chat cursor advances only after its shared day and organic Contact are written", async () => {
    const { t, owner, workspaceId, connectionId, backend } = await endToEnd();
    await patchConnection(t, connectionId, {
      products: ["chat"],
      gmail: undefined,
      chat: {
        scopes: [
          "https://www.googleapis.com/auth/chat.messages.readonly",
          "https://www.googleapis.com/auth/chat.spaces.readonly",
        ],
        nonceSeed: "fixture-chat-nonce-seed",
        cursors: { "spaces/alpha": "2026-09-12T09:00:00.000Z" },
      },
    });
    const google = chatAndBucket({ backend });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({
      kind: "googleForwardSync",
      status: "synced",
      cursorAdvanced: true,
    });
    const row = await readConnection(t, connectionId);
    expect(row.chat?.cursors?.["spaces/alpha"]).toBe("2026-09-12T10:00:00.000Z");
    expect(row.chat?.lastSyncedAt).toBeTypeOf("number");
    const view = (
      await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
        workspaceId,
      })
    )[0]!;
    expect(view.sync.everSynced).toBe(true);
    expect(view.sync.cursorReady).toBe(true);
    const written = backend.snapshot();
    expect(written["2-areas/communications/daily/2026-09-12.md"]).toContain(
      "Ship the live Chat bridge",
    );
    expect(Object.entries(written)).toContainEqual([
      expect.stringMatching(/^0-inbox\/contacts\//),
      expect.stringContaining("Adam Okonkwo"),
    ]);
    expect(google.calls).toEqual(["/v1/spaces", "/v1/spaces/alpha/messages"]);
  });

  test("a Calendar cursor advances only after its shared day is written", async () => {
    // Keep this fixture's event inside the full-sync horizon regardless of
    // the wall-clock date on which the suite runs.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T16:00:00.000Z"));
    const { t, owner, workspaceId, connectionId, backend } = await endToEnd();
    await patchConnection(t, connectionId, {
      products: ["calendar"],
      gmail: undefined,
      calendar: {
        scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      },
    });
    const google = calendarAndBucket({ backend });
    vi.stubGlobal("fetch", google.fetchImpl);
    /*
      PINNED, BECAUSE THE ASSERTIONS BELOW NAME PARTICULAR DAYS.

      `lastFullSyncDate` is today in the *calendar's* zone, and this fixture's
      calendar is `America/New_York` — so a test hardcoding `2026-09-12` only
      passes while it is still that day in New York, and this one started
      failing at 04:00 UTC when it stopped being. It had nothing to do with any
      change; the suite simply rots once a day, in a way CI notices only if a
      run happens to land after the boundary.

      `shouldAdvanceTime` keeps real timers running underneath, because
      convex-test drives scheduled functions on them and a frozen clock would
      hang them.
    */
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      now: new Date("2026-09-12T18:00:00.000Z"),
    });

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({
      kind: "googleForwardSync",
      status: "synced",
      cursorAdvanced: true,
    });
    const row = await readConnection(t, connectionId);
    expect(row.calendar?.syncToken).toBe("calendar-token-2");
    // 14:00 on the 12th in New York, so "today" there is the 12th.
    expect(row.calendar?.lastFullSyncDate).toBe("2026-09-12");
    expect(row.calendar?.lastSyncedAt).toBeTypeOf("number");
    const view = (
      await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
        workspaceId,
      })
    )[0]!;
    expect(view.sync.everSynced).toBe(true);
    expect(view.sync.cursorReady).toBe(true);
    expect(backend.snapshot()["0-inbox/calendar/2026-09-13.md"]).toContain(
      "Design review",
    );
    expect(google.calls).toEqual(["/calendar/v3/calendars/primary/events"]);
  });

  test("a Calendar cursor stays put until every account for the folder has a contribution", async () => {
    const { t, owner, workspaceId, connectionId, backend } = await endToEnd();
    const siblingId = await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "sibling@example.invalid",
    });
    for (const id of [connectionId, siblingId]) {
      await patchConnection(t, id, {
        products: ["calendar"],
        gmail: undefined,
        calendar: {
          scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
          destinationFolder: "0-inbox/calendar",
          ...(id === connectionId ? { syncToken: "calendar-token-1" } : {}),
        },
      });
    }
    const google = calendarAndBucket({ backend });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({
      status: "skipped",
      cursorAdvanced: false,
      errorCode: "CALENDAR_WAITING_FOR_ACCOUNT",
    });
    expect((await readConnection(t, connectionId)).calendar?.syncToken).toBe(
      "calendar-token-1",
    );
    expect(backend.snapshot()["0-inbox/calendar/2026-09-13.md"]).toBeUndefined();
    expect(
      Object.keys(backend.snapshot()).some((path) =>
        path.startsWith(".context/communications/calendar/contributions/"),
      ),
    ).toBe(true);

    const keyset = requireKeyset();
    await t.run(async (ctx) => {
      await ctx.db.patch(siblingId, {
        encryptedAccessToken: await encryptSecret("sibling-access-token-not-real", keyset, {
          workspaceId,
        }),
        accessTokenExpiresAt: Date.now() + 30 * MINUTE,
        syncStartedAt: Date.now(),
      });
    });
    const siblingResult = await runPass(t, workspaceId, siblingId);
    expect(siblingResult).toMatchObject({ status: "synced", cursorAdvanced: true });
    const shared = backend.snapshot()["0-inbox/calendar/2026-09-13.md"]!;
    expect(shared).toContain("person@example.invalid");
    expect(shared).toContain("sibling@example.invalid");
  });

  test("a Chat cursor stays put until every active account has a complete contribution", async () => {
    const { t, owner, workspaceId, connectionId, backend } = await endToEnd();
    const siblingId = await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "sibling@example.invalid",
    });
    const chat = (nonceSeed: string) => ({
      scopes: [
        "https://www.googleapis.com/auth/chat.messages.readonly",
        "https://www.googleapis.com/auth/chat.spaces.readonly",
      ],
      nonceSeed,
      cursors: { "spaces/alpha": "2026-09-12T09:00:00.000Z" },
    });
    await patchConnection(t, connectionId, {
      products: ["chat"],
      gmail: undefined,
      chat: chat("fixture-chat-nonce-seed-a"),
    });
    await patchConnection(t, siblingId, {
      products: ["chat"],
      gmail: undefined,
      chat: chat("fixture-chat-nonce-seed-b"),
    });
    const google = chatAndBucket({ backend });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({
      status: "skipped",
      cursorAdvanced: false,
      errorCode: "CHAT_WAITING_FOR_ACCOUNT",
    });
    expect((await readConnection(t, connectionId)).chat?.cursors?.["spaces/alpha"]).toBe(
      "2026-09-12T09:00:00.000Z",
    );
    expect(backend.snapshot()["2-areas/communications/daily/2026-09-12.md"]).toBeUndefined();
    expect(
      Object.keys(backend.snapshot()).some((path) =>
        path.startsWith(".context/communications/google-chat/contributions/"),
      ),
    ).toBe(true);
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

  test("a walk that runs out of pages stores the record boundary, not the head", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    // Fifty-one pages against a fifty-page walk: the client stops one short of
    // the end, and every page has claimed the mailbox head all along.
    const pages = Array.from({ length: 51 }, (_, index) => ({
      recordId: String(1100 + index),
    }));
    const google = googleAndBucket({ backend, history: { pages, historyId: "999999" } });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "synced", truncated: true });
    const row = await readConnection(t, connectionId);
    /*
      The head would say "caught up" while fifty-one pages of history had been
      read and everything behind them skipped forever. The last record actually
      walked says where to resume, and the row says there is more.
    */
    expect(row.gmail?.historyId).toBe("1149");
    expect(row.gmail?.historyId).not.toBe("999999");
    expect(row.syncCatchUp).toBe(true);
    expect(row.nextSyncAt).toBeLessThanOrEqual(Date.now());
    expect((await sweep(t)).started).toBe(1);
  });

  test("...and the next pass carries on from there rather than repeating itself", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1149" });
    const google = googleAndBucket({
      backend,
      history: { pages: [{ recordId: "1150" }], historyId: "999999" },
    });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "synced", truncated: false });
    const row = await readConnection(t, connectionId);
    // A walk that reached the end may store the head, and only then.
    expect(row.gmail?.historyId).toBe("999999");
    expect(row.syncCatchUp).toBeUndefined();
  });

  test("a truncated walk with no record boundary fails visibly instead of spinning forever", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const pages = Array.from({ length: 51 }, () => ({}));
    const google = googleAndBucket({ backend, history: { pages, historyId: "999999" } });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({
      status: "failed",
      truncated: true,
      cursorAdvanced: false,
      errorCode: "GOOGLE_SYNC_NO_RESUME_CURSOR",
    });
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("1000");
    expect(row.syncCatchUp).toBeUndefined();
    expect(row.nextSyncAt).toBeGreaterThan(Date.now());
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

  test("bytes written before a quota ceiling are counted, or the ceiling never arrives", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({
      historyId: "1000",
      // Room for the first day and not the second: the pass writes, then stops.
      quotaBytes: 2_400,
    });
    const google = googleAndBucket({
      backend,
      history: { messageIds: ["msg-1", "msg-2"], historyId: "1100" },
      messages: [
        {
          id: "msg-1",
          date: "2026-09-08T09:14:00.000Z",
          subject: "Quarterly numbers",
          text: "The numbers are attached.",
        },
        {
          id: "msg-2",
          date: "2026-09-09T09:14:00.000Z",
          subject: "Follow-up",
          text: "And the follow-up.",
        },
      ],
    });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "failed", errorCode: "MAIL_QUOTA_EXCEEDED" });
    const row = await readConnection(t, connectionId);
    /*
      The whole point of the ceiling. A failed pass that wrote real bytes and
      then dropped the count leaves `bytesAlreadyUsed` frozen below the limit,
      so every later pass re-writes the same day, re-counts nothing, and the
      ceiling is never crossed — a quota that cannot be reached is decoration.
    */
    expect(row.syncBytesWritten).toBeGreaterThan(0);
    expect(row.gmail?.historyId).toBe("1000");
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

  test.each([
    [429, {}, "GOOGLE_RATE_LIMITED"],
    [403, { reason: "userRateLimitExceeded" }, "GOOGLE_RATE_LIMITED"],
    [403, {}, "GOOGLE_ACCESS_REFUSED"],
    [503, {}, "GOOGLE_UNAVAILABLE"],
    [418, {}, "GMAIL_HTTP_418"],
  ])(
    "Gmail answering %i is classified, not flattened into one sentence",
    async (status, detail, expected) => {
      const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
      const google = googleAndBucket({ backend });
      vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
        const url = new URL(typeof input === "string" ? input : String(input));
        if (url.hostname === "gmail.googleapis.com") {
          return new Response(
            JSON.stringify({
              error: {
                code: status,
                message: "denied",
                errors: "reason" in detail ? [{ reason: detail.reason }] : undefined,
              },
            }),
            { status, headers: { "content-type": "application/json" } },
          );
        }
        return await google.fetchImpl(input, init);
      });

      const result = await runPass(t, workspaceId, connectionId);

      expect(result).toMatchObject({ status: "failed", errorCode: expected });
      const row = await readConnection(t, connectionId);
      expect(row.lastSyncFailureCode).toBe(expected);
      // The advice has to match the cause: telling somebody to reconnect and
      // re-approve Gmail for a rate limit that clears itself is worse than
      // saying nothing.
      if (expected === "GOOGLE_RATE_LIMITED" || expected === "GOOGLE_UNAVAILABLE") {
        expect(row.lastSyncFailure).not.toContain("Reconnect");
      }
      // Nothing that failed advanced the cursor.
      expect(row.gmail?.historyId).toBe("1000");
    },
  );

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
