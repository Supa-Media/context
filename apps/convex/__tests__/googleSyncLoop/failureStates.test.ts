import { beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  asUser,
  addMember,
  createUser,
  errorCode,
  type TestConvex,
} from "../fixtures.helpers";
import {
  DEFAULT_SYNC_INTERVAL_MINUTES,
  MAX_SYNC_BACKOFF_MS,
} from "../../functions/lib/googleSchedule";
import {
  MINUTE,
  enableMailSync,
  scenario,
  patchConnection,
  readConnection,
  sweep,
} from "./fixtures";

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

describe("the sweep records where a connection is filing, for rows written before it was recorded", () => {
  /*
    The other half of the rule `chatProduct.test.ts` states in full under
    "a connection records the folder it files into": connects made before that
    pin exists left `destinationFolder` absent, so their folder goes on being
    whatever `defaultGoogleDestinationFolder` says in source TODAY. Editing
    that constant relocates them — and a Chat pass re-renders every retained
    day, so the relocation is a year of somebody's conversations appearing at
    new keys, unannounced, with any `note_overrides` exception they had set
    left behind on the old paths (`remapPrivacy` carries an exception across a
    move; nothing carries one across a re-render).

    The sweep already patches this row to claim it. Recording the folder it is
    filing into at that moment costs nothing, changes no key, and turns the
    live rows from floating into pinned.

    Sabotage: drop the `destinationFolder` branch from the claim patch and the
    folder stays absent.
  */
  beforeEach(() => enableMailSync());

  test("claiming a connection with no recorded folder records the one it is already using", async () => {
    const { t, connectionId } = await scenario();
    expect((await readConnection(t, connectionId)).gmail?.destinationFolder).toBeUndefined();

    expect((await sweep(t)).started).toBe(1);

    const row = await readConnection(t, connectionId);
    expect(row.gmail?.destinationFolder).toBe("0-inbox/email/person-at-example-invalid");
  });

  test("...and never moves one that is already recorded", async () => {
    const { t, connectionId } = await scenario();
    const row = await readConnection(t, connectionId);
    await patchConnection(t, connectionId, {
      gmail: { ...row.gmail!, destinationFolder: "2-areas/mail" },
    });

    expect((await sweep(t)).started).toBe(1);

    expect((await readConnection(t, connectionId)).gmail?.destinationFolder).toBe("2-areas/mail");
  });
});
