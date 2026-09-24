import { beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import {
  errorCode,
  createUser,
  createWorkspace,
  seedGoogleConnection,
  setupTest,
} from "../fixtures.helpers";
import {
  SYNC_FAILURE_BACKOFF_MS,
} from "../../functions/lib/googleSchedule";
import {
  MINUTE,
  enableMailSync,
  scenario,
  patchConnection,
  readConnection,
  sweep,
  googleAndBucket,
  endToEnd,
  type Scenario,
} from "./fixtures.helpers";

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
      destinationFolder: "0-inbox/google-chat",
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

