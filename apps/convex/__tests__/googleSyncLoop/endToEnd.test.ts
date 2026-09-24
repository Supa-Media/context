import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import {
  asUser,
  errorCode,
  seedGoogleConnection,
  FAKE_STORAGE,
} from "../fixtures.helpers";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { readDocument, replaceText } from "@context/collaboration";
import { S3Store } from "../../../mcp/src/store/s3.js";
import { withLogicalDelete, isLogicalDeleteMarker } from "../../../mcp/src/store/logicalDelete.js";
import {
  MINUTE,
  enableMailSync,
  patchConnection,
  readConnection,
  sweep,
  googleAndBucket,
  chatAndBucket,
  calendarAndBucket,
  endToEnd,
  runPass,
} from "./fixtures.helpers";

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
    const day = "0-inbox/email/person-at-example-invalid/2026/09/2026-09-08.md";
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
    expect(written["0-inbox/google-chat/2026/09/2026-09-12.md"]).toContain(
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
    expect(backend.snapshot()["0-inbox/calendar/2026/09/2026-09-13.md"]).toContain(
      "Design review",
    );
    expect(google.calls).toEqual(["/calendar/v3/calendars/primary/events"]);
  });

  test("Calendar updates and removals use the initialized collaboration document", async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      now: new Date("2026-09-12T18:00:00.000Z"),
    });
    const { t, workspaceId, connectionId, backend } = await endToEnd();
    await t.run(async (ctx) => {
      const binding = (await ctx.db.query("storageBindings").first())!;
      await ctx.db.patch(binding._id, {
        capabilities: {
          conditionalWrite: true,
          conditionalCreate: true,
          conditionalDelete: true,
        },
      });
    });
    await patchConnection(t, connectionId, {
      products: ["calendar"],
      gmail: undefined,
      calendar: {
        scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      },
    });
    const path = "0-inbox/calendar/2026/09/2026-09-13.md";
    vi.stubGlobal("fetch", calendarAndBucket({ backend }).fetchImpl);
    await runPass(t, workspaceId, connectionId);

    const store = withLogicalDelete(new S3Store({
      ...FAKE_STORAGE,
      forcePathStyle: true,
      fetchImpl: backend.fetchImpl,
    }));
    const initial = await readDocument(store, path);
    const edited = await replaceText(store, path, {
      documentId: initial.documentId,
      expectedEtag: initial.etag,
      text: `${initial.text}\nPeer's in-flight calendar note.\n`,
    });
    expect(edited.text).toContain("Peer's in-flight calendar note.");

    // The next sync must update the CRDT-backed note, rather than replacing
    // only Markdown and leaving readDocument able to materialize stale prose.
    vi.stubGlobal(
      "fetch",
      calendarAndBucket({
        backend,
        items: [
          {
            id: "event-1",
            status: "confirmed",
            summary: "Updated design review",
            start: { dateTime: "2026-09-13T14:00:00.000Z" },
            end: { dateTime: "2026-09-13T14:30:00.000Z" },
          },
        ],
      }).fetchImpl,
    );
    await runPass(t, workspaceId, connectionId);
    const updated = await readDocument(store, path);
    expect(updated.text).toContain("Updated design review");
    expect(updated.text).not.toContain("Peer's in-flight calendar note.");

    // A cancellation must tombstone the same generation. A later read cannot
    // recreate the old calendar Markdown from its retained collaboration data.
    vi.stubGlobal(
      "fetch",
      calendarAndBucket({
        backend,
        items: [
          {
            id: "event-1",
            status: "cancelled",
            start: { dateTime: "2026-09-13T14:00:00.000Z" },
            end: { dateTime: "2026-09-13T14:30:00.000Z" },
          },
        ],
      }).fetchImpl,
    );
    await runPass(t, workspaceId, connectionId);
    expect(isLogicalDeleteMarker(backend.snapshot()[path])).toBe(true);
    expect(await store.get(path)).toBeNull();
    await expect(readDocument(store, path)).rejects.toMatchObject({ code: "DELETED" });
  });

  test("a Calendar cursor stays put until every account for the folder has a contribution", async () => {
    /*
      PINNED, for the reason the test two above states at length: the full-sync
      window starts at *today* in the calendar's zone (`America/New_York`
      here), so a fixture whose only event is on the 13th falls out of the
      window the moment it stops being the 13th in New York — 04:00 UTC — and
      the shared day file this asserts is never written. Unpinned, this passed
      for one day and has failed every day since, on a clock rather than on a
      change.

      `shouldAdvanceTime`, because convex-test drives scheduled functions on
      real timers and a frozen clock hangs them.
    */
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      now: new Date("2026-09-12T18:00:00.000Z"),
    });
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
    /*
      PINNED, FOR THE REASON THE TEST TWO ABOVE ALREADY WRITES OUT.

      This one names `0-inbox/calendar/2026-09-13.md` as well, and the day a
      calendar sync writes is bounded by a horizon measured from *today*:
      `calendar-sync.js` keeps only `date >= windowStart`. So the fixture's
      event on the 13th stopped being written the moment it stopped being the
      13th in New York, and this test began failing on every run from
      2026-09-14 — on `main`, for every branch, with nothing having changed.

      Its neighbour was pinned when it rotted the same way. This one was missed,
      which is the whole argument for the comment: a hardcoded date in this file
      is a test with an expiry date on it unless the clock is pinned beside it.
    */
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      now: new Date("2026-09-12T18:00:00.000Z"),
    });

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({
      status: "skipped",
      cursorAdvanced: false,
      errorCode: "CALENDAR_WAITING_FOR_ACCOUNT",
    });
    expect((await readConnection(t, connectionId)).calendar?.syncToken).toBe(
      "calendar-token-1",
    );
    expect(backend.snapshot()["0-inbox/calendar/2026/09/2026-09-13.md"]).toBeUndefined();
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
    const shared = backend.snapshot()["0-inbox/calendar/2026/09/2026-09-13.md"]!;
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
    expect(backend.snapshot()["0-inbox/google-chat/2026/09/2026-09-12.md"]).toBeUndefined();
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

