import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  addMember,
  errorCode,
  seedGoogleConnection,
  setupTest,
} from "../fixtures.helpers";
import {
  DEFAULT_SYNC_INTERVAL_MINUTES,
  MAX_SYNC_INTERVAL_MINUTES,
  MIN_SYNC_INTERVAL_MINUTES,
  SYNC_STALL_MS,
} from "../../functions/lib/googleSchedule";
import {
  MINUTE,
  enableMailSync,
  scenario,
  patchConnection,
  readConnection,
  sweep,
} from "./fixtures";

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

