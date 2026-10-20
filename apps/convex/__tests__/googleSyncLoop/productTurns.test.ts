import { beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { asUser, type TestConvex } from "../fixtures.helpers";
import { nextProductToSync } from "../../functions/lib/googleSchedule";
import { classifyForwardSyncError, ForwardSyncStorageError, safeErrorDetail } from "../../functions/lib/filesFns/forwardSyncSupport";
import { GmailApiError } from "../../../mcp/src/communications/gmailSync.js";
import { enableMailSync, patchConnection, readConnection, scenario } from "./fixtures.helpers";

/*
  ONE PRODUCT THAT FAILS EVERY PASS MUST NOT TAKE EVERY TURN.

  One pass syncs one product, the one whose turn is oldest. Measured by
  success alone, a Calendar that failed every pass never had a success on
  record, so it was "oldest" forever and was picked on every pass: on
  production, a broken Calendar left Chat waiting for its first sync and Gmail
  stalled after its first pass, on the same account.

  Sabotage: make `nextProductToSync` order by `lastSyncedAt` alone again, or
  drop `productTurnPatch` from the failed branch of
  `recordGoogleForwardSyncPass`, and the second job below is Calendar again.
*/

async function addCalendarAndChat(t: TestConvex, connectionId: Id<"googleConnections">) {
  const row = await readConnection(t, connectionId);
  await patchConnection(t, connectionId, {
    products: ["gmail", "calendar", "chat"],
    gmail: { ...row.gmail!, historyId: "100", lastSyncedAt: Date.now() - 60 * 60_000 },
    calendar: {
      scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      destinationFolder: "0-inbox/calendar",
    },
    chat: {
      scopes: [
        "https://www.googleapis.com/auth/chat.messages.readonly",
        "https://www.googleapis.com/auth/chat.spaces.readonly",
      ],
      destinationFolder: "0-inbox/google-chat",
      nonceSeed: "fixture-chat-nonce-seed",
    },
  });
}

async function nextJobProduct(t: TestConvex, workspaceId: Id<"workspaces">, connectionId: Id<"googleConnections">) {
  const job = await t.query(internal.functions.googleSync.googleForwardSyncJob, { workspaceId, connectionId });
  if (job === null || job.kind !== "run") throw new Error(`expected a run, got ${JSON.stringify(job)}`);
  return job.product;
}

describe("a product that keeps failing", () => {
  beforeEach(() => enableMailSync());

  test("spends its turn, so its siblings get the next ones", async () => {
    const { t, workspaceId, connectionId } = await scenario();
    await addCalendarAndChat(t, connectionId);

    expect(await nextJobProduct(t, workspaceId, connectionId)).toBe("calendar");
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      product: "calendar",
      status: "failed",
      errorCode: "STORAGE_CONDITIONAL_WRITES_REQUIRED",
      error: "Calendar needs storage that supports safe shared writes.",
    });

    expect(await nextJobProduct(t, workspaceId, connectionId)).toBe("chat");
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      product: "chat",
      status: "synced",
      chatCursors: {},
    });

    // Gmail's success an hour ago is older than Calendar's failure just now.
    expect(await nextJobProduct(t, workspaceId, connectionId)).toBe("gmail");
  });

  test("a skipped turn is spent too", async () => {
    const { t, workspaceId, connectionId } = await scenario();
    await addCalendarAndChat(t, connectionId);
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      product: "calendar",
      status: "skipped",
      errorCode: "CALENDAR_WAITING_FOR_ACCOUNT",
    });
    expect(await nextJobProduct(t, workspaceId, connectionId)).toBe("chat");
  });

  test("the owner reads which service failed and why, until it syncs again", async () => {
    const { t, owner, workspaceId, connectionId } = await scenario();
    await addCalendarAndChat(t, connectionId);
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      product: "calendar",
      status: "failed",
      errorCode: "CALENDAR_CURSOR_MISSING",
      error: "Google Calendar did not return a place to resume from.",
    });
    const [failed] = await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, { workspaceId });
    expect(failed!.calendar?.lastFailure).toBe("Google Calendar did not return a place to resume from.");
    expect(failed!.chat?.lastFailure).toBeUndefined();
    expect(failed!.gmail?.lastFailure).toBeUndefined();

    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      product: "calendar",
      status: "synced",
      calendarSyncToken: "calendar-sync-token",
    });
    const row = await readConnection(t, connectionId);
    expect(row.calendar).toMatchObject({ lastSyncedAt: expect.any(Number) });
    expect(row.calendar?.lastFailure).toBeUndefined();
    expect(row.calendar?.lastFailureCode).toBeUndefined();
    expect(row.calendar?.lastAttemptAt).toBeUndefined();
  });

  test("a sibling's success does not make the product that just failed due at once", async () => {
    const { t, connectionId } = await scenario();
    await addCalendarAndChat(t, connectionId);
    const row = await readConnection(t, connectionId);
    const now = Date.now();
    await patchConnection(t, connectionId, {
      calendar: { ...row.calendar!, lastAttemptAt: now },
      chat: { ...row.chat!, lastSyncedAt: now },
    });
    await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId,
      product: "gmail",
      status: "synced",
      historyId: "200",
    });
    const after = await readConnection(t, connectionId);
    expect(after.nextSyncAt).toBeGreaterThan(Date.now());
  });
});

describe("nextProductToSync", () => {
  test("orders by the last turn, a failure counting as one", () => {
    const now = 1_000_000;
    expect(
      nextProductToSync(
        { gmail: { lastSyncedAt: now - 10 }, calendar: { lastAttemptAt: now }, chat: { lastSyncedAt: now - 5 } },
        ["gmail", "calendar", "chat"] as const,
        now,
      ),
    ).toBe("gmail");
  });

  test("a product that has never had a turn still goes first", () => {
    expect(
      nextProductToSync({ gmail: { lastSyncedAt: 5 }, calendar: { lastAttemptAt: 9 }, chat: {} }, [
        "gmail",
        "calendar",
        "chat",
      ] as const, 10),
    ).toBe("chat");
  });
});

describe("the failures the catch-all used to hide", () => {
  test("storage without conditional writes names storage, per product", () => {
    expect(classifyForwardSyncError(new ForwardSyncStorageError("calendar")).code).toBe(
      "STORAGE_CONDITIONAL_WRITES_REQUIRED",
    );
    expect(classifyForwardSyncError(new ForwardSyncStorageError("chat")).message).toMatch(/^Chat /);
  });
});

describe("a Gmail rate limit carries when it lifts and which call met it", () => {
  test("the classifier passes both to the pass record", () => {
    const error = new GmailApiError(429, "Gmail answered /gmail/v1/users/me/history with 429", {
      reason: "rateLimitExceeded",
      retryAfterAt: 1_800_000_000_000,
      call: "history",
    });
    expect(classifyForwardSyncError(error)).toMatchObject({
      code: "GOOGLE_RATE_LIMITED",
      reason: "rateLimitExceeded",
      retryAfterAt: 1_800_000_000_000,
      call: "history",
    });
  });
});

describe("the catch-all says what it caught, without a note's name", () => {
  test("a path or a quoted name in an unknown error never reaches the message", () => {
    const { code, message } = classifyForwardSyncError(
      new TypeError('Cannot write "Secret plans" at 0-inbox/calendar/2026-10-15.md today'),
    );
    expect(code).toBe("GOOGLE_SYNC_FAILED");
    expect(message).toContain("TypeError: Cannot write");
    expect(message).not.toContain("Secret");
    expect(message).not.toContain("0-inbox");
    expect(message).not.toContain("2026-10-15");
  });

  test("a bare file name is cut out too", () => {
    expect(safeErrorDetail(new Error("refused plans.md"))).toBe("refused …");
  });
});
