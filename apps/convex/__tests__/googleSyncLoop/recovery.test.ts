import { beforeEach, describe, expect, test, vi } from "vitest";
import { CalendarApiError } from "../../../mcp/src/communications/calendar-google.js";
import { ChatApiError } from "../../../mcp/src/communications/googleChat/client.js";
import { GmailApiError } from "../../../mcp/src/communications/gmailSync.js";
import { classifyForwardSyncError } from "../../functions/lib/filesFns/forwardSyncSupport";
import { isProductTransient } from "../../functions/lib/googleSchedule";
import {
  enableMailSync,
  endToEnd,
  googleAndBucket,
  jsonResponse as json,
  patchConnection,
  readConnection,
  runPass,
  withoutCachedToken,
  withTokenEndpoint,
} from "./fixtures.helpers";

/*
  EMAIL KEEPS WORKING UNLESS THE PERSON HAS TO GIVE A NEW PERMISSION.

  Each block below is one way a connected mailbox used to stop, or tell its
  owner to reconnect, over something that was never theirs to fix:
  `docs/decisions/communications/gmail-and-sync-loop.md`, "Recovering without
  the owner".
*/

beforeEach(() => enableMailSync());

describe("a refresh Google could not answer is not a reconnect", () => {
  /*
    Sabotage: map every failed mint to `GOOGLE_RECONNECT_REQUIRED` again (the
    old `minted === null` branch in `forwardSync.ts`) and these come back as
    an account-level failure with health `error` and "Reconnect" advice.
  */
  test.each([
    ["a 503", () => json({ error: "backend_error" }, 503)],
    ["a 429", () => json({ error: "rate_limit_exceeded" }, 429)],
    [
      "no answer at all",
      () => {
        throw new TypeError("network unreachable");
      },
    ],
  ])("%s from the token endpoint backs Gmail off by itself", async (_, answer) => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    await withoutCachedToken(t, connectionId);
    const google = withTokenEndpoint(googleAndBucket({ backend }).fetchImpl, answer);
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "failed", errorCode: "GOOGLE_UNAVAILABLE" });
    expect(google.calls.token).toBe(1);
    const row = await readConnection(t, connectionId);
    expect(row.health).toBe("active");
    expect(row.syncFailures).toBeUndefined();
    expect(row.gmail?.retryAt).toBeGreaterThan(Date.now());
    expect(row.gmail?.lastFailureCode).toBe("GOOGLE_UNAVAILABLE");
    expect(row.lastSyncFailure).not.toContain("Reconnect");
    expect(row.gmail?.historyId).toBe("1000");
  });

  /*
    The access token the pass was handed was refused (revoked early, or the
    clock was wrong). Reusing the cached one would fail every pass until it
    expired by itself. Sabotage: drop the `dropCachedAccessToken` call from
    `forwardSyncFailed`, and the row still holds the refused token.
  */
  test("a 401 drops the cached access token and is not an account failure", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const google = googleAndBucket({ backend });
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.hostname === "gmail.googleapis.com") return json({ error: { code: 401, message: "expired" } }, 401);
      return await google.fetchImpl(input, init);
    });

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "failed", errorCode: "GOOGLE_TOKEN_REJECTED" });
    const row = await readConnection(t, connectionId);
    expect(row.encryptedAccessToken).toBeUndefined();
    expect(row.accessTokenExpiresAt).toBeUndefined();
    expect(row.health).toBe("active");
    expect(row.lastSyncFailure).not.toContain("Reconnect");
  });
});

describe("an empty history id is no cursor", () => {
  /*
    Sabotage: check `job.historyId === undefined` again in `forwardSync.ts`
    and the stored "" is handed to `history.list` as a cursor.
  */
  test("a stored empty cursor takes a baseline instead of walking history from nothing", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "" });
    const google = googleAndBucket({ backend, profileHistoryId: "7000" });
    vi.stubGlobal("fetch", google.fetchImpl);

    await runPass(t, workspaceId, connectionId);

    expect(google.calls).toEqual(["/gmail/v1/users/me/profile"]);
    expect((await readConnection(t, connectionId)).gmail?.historyId).toBe("7000");
  });

  test("a profile with no history id stores no cursor", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd();
    const google = googleAndBucket({ backend });
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.pathname === "/gmail/v1/users/me/profile") return json({});
      return await google.fetchImpl(input, init);
    });

    await runPass(t, workspaceId, connectionId);

    expect((await readConnection(t, connectionId)).gmail?.historyId).toBeUndefined();
  });
});

describe("Calendar and Chat rate limits stay their own product's", () => {
  /*
    Sabotage: classify a Calendar or Chat 403 as GOOGLE_ACCESS_REFUSED again
    without reading its reason, and these become account failures that stop
    Gmail too.
  */
  test.each([
    ["Calendar", (details: object) => new CalendarApiError(403, "primary", details)],
    ["Chat", (details: object) => new ChatApiError("refused", "RATE_LIMITED", 403, details)],
    ["Gmail", (details: object) => new GmailApiError(403, "refused", details)],
  ])("%s 403 rateLimitExceeded is a rate limit", (_, make) => {
    const limited = classifyForwardSyncError(make({ reason: "rateLimitExceeded" }));
    expect(limited).toMatchObject({ code: "GOOGLE_RATE_LIMITED", reason: "rateLimitExceeded" });
    expect(isProductTransient(limited.code)).toBe(true);
    expect(classifyForwardSyncError(make({ googleStatus: "RESOURCE_EXHAUSTED" })).code).toBe("GOOGLE_RATE_LIMITED");
    expect(classifyForwardSyncError(make({ reason: "forbidden" })).code).toBe("GOOGLE_ACCESS_REFUSED");
  });

  test.each([
    ["Calendar", new CalendarApiError(401, "primary")],
    ["Chat", new ChatApiError("expired", "UNAVAILABLE", 401)],
    ["Gmail", new GmailApiError(401, "expired")],
  ])("a %s 401 is a refused token the next pass replaces", (_, error) => {
    const { code, message } = classifyForwardSyncError(error);
    expect(code).toBe("GOOGLE_TOKEN_REJECTED");
    expect(isProductTransient(code)).toBe(true);
    expect(message).not.toContain("Reconnect");
  });

  test("a Calendar pass Google rate-limited leaves the account healthy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T16:00:00.000Z"));
    const { t, workspaceId, connectionId, backend } = await endToEnd();
    await patchConnection(t, connectionId, {
      products: ["calendar"],
      gmail: undefined,
      calendar: { scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"] },
    });
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.hostname === "www.googleapis.com") {
        return json({ error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "rateLimitExceeded" }] } }, 403);
      }
      return await backend.fetchImpl(input, init);
    });

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ status: "failed", errorCode: "GOOGLE_RATE_LIMITED" });
    const row = await readConnection(t, connectionId);
    expect(row.health).toBe("active");
    expect(row.calendar?.lastFailureReason).toBe("rateLimitExceeded");
  });
});
