import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { asUser, type TestConvex } from "../fixtures.helpers";
import {
  REDIRECT,
  GMAIL_SCOPE,
  CALENDAR_SCOPE,
  CALENDAR_REQUEST_SCOPE,
  enableCalendarConnect,
  enableMailConnect,
  personalScenario,
  bindGmail,
  connectionRow,
  bindCalendar,
} from "./fixtures.helpers";

/**
 * A DISCONNECT IS NOT UNDONE BY ADDING A DIFFERENT PRODUCT — the Calendar
 * half, and the Gmail half the Chat review left standing because it was in
 * merged code this branch was already working in.
 *
 * `disconnectGoogleConnection` revokes the whole grant and deliberately keeps
 * `products` as a record of what the connection USED to sync. Two paths read
 * that array as if it were consent: the scope REQUEST (which would re-ask
 * Google for `gmail.readonly` — a restricted scope — on the strength of a
 * revocation) and the BINDING (which would put the product back on the live
 * set). Chat closed both for itself; these are the same two for Calendar,
 * plus the mirror inside `applyGmailConnectionBinding`.
 */
describe("a disconnect is not undone by adding a different product", () => {
  async function disconnectedGmailRow(t: TestConvex, workspaceId: Id<"workspaces">, owner: Id<"users">) {
    await bindGmail(t, workspaceId, owner);
    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    await t.run((ctx) =>
      ctx.db.patch(row!._id, {
        encryptedRefreshToken: "",
        encryptedAccessToken: undefined,
        health: "error" as const,
        disconnectedAt: Date.now(),
      }),
    );
    return row!._id;
  }

  test("a Calendar connect on a DISCONNECTED account never re-requests the mail scope", async () => {
    enableCalendarConnect();
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    await disconnectedGmailRow(t, workspaceId, owner);

    const result = await asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    const scopes = (new URL(result.authorizeUrl).searchParams.get("scope") ?? "").split(" ");
    // Restricted scope, re-asked for on the strength of a revocation, is the
    // exact thing disconnecting was supposed to end.
    expect(scopes).not.toContain(GMAIL_SCOPE);
    expect(scopes).toContain(CALENDAR_REQUEST_SCOPE);
    const attempt = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(attempt[0]?.products).toEqual(["calendar"]);
  });

  test("...and binding Calendar onto it revives Calendar and nothing else", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await disconnectedGmailRow(t, workspaceId, owner);

    await bindCalendar(t, workspaceId, owner, { scopes: [CALENDAR_SCOPE] });

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.products).toEqual(["calendar"]);
    // Gmail's own settings survive — a mailbox slug is a folder somebody's
    // mail is sitting in, not a consent — and its scope slice is empty,
    // because this grant does not carry one.
    expect(row?.gmail?.mailboxSlug).toBe("person-at-example-invalid");
    expect(row?.gmail?.scopes).toEqual([]);
    // And with Gmail off the live set, nothing is starved: the connection is
    // a working Calendar connection, not a broken Gmail one.
    expect(row?.health).toBe("active");
    expect(row?.errorCode).toBeUndefined();
    expect(row?.disconnectedAt).toBeUndefined();
  });

  test("the mirror: reconnecting GMAIL on a disconnected account does not revive Calendar or Chat", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);
    await bindCalendar(t, workspaceId, owner, { scopes: [GMAIL_SCOPE, CALENDAR_SCOPE] });
    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.products.sort()).toEqual(["calendar", "gmail"]);
    await t.run((ctx) =>
      ctx.db.patch(row!._id, {
        encryptedRefreshToken: "",
        encryptedAccessToken: undefined,
        health: "error" as const,
        disconnectedAt: Date.now(),
      }),
    );

    // The person reconnects mail alone. Gmail's own request asks for Gmail's
    // scopes only, so the grant carries nothing for Calendar — and Calendar
    // must not be put back on the row claiming a consent this grant lacks.
    await bindGmail(t, workspaceId, owner, { scopes: [GMAIL_SCOPE] });

    const after = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(after?.products).toEqual(["gmail"]);
    expect(after?.calendar?.scopes).toEqual([]);
    // Calendar's own cursor is kept — it is a sync position, not consent.
    expect(after?.calendar).toBeDefined();
    expect(after?.health).toBe("backfilling");
    expect(after?.errorCode).toBeUndefined();
  });

  test("a Gmail reconnect whose grant drops Calendar's scope while Calendar is still live says so", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);
    await bindCalendar(t, workspaceId, owner, { scopes: [GMAIL_SCOPE, CALENDAR_SCOPE] });

    // No disconnect this time: both products are live, and the person
    // unchecks the calendar box on Google's consent screen.
    await bindGmail(t, workspaceId, owner, { scopes: [GMAIL_SCOPE] });

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.products.sort()).toEqual(["calendar", "gmail"]);
    expect(row?.calendar?.scopes).toEqual([]);
    expect(row?.health).toBe("reconnect_required");
    expect(row?.errorCode).toBe("SCOPES_INCOMPLETE");
    expect(row?.lastError).toContain("calendar");
    // The message names this module's own product literals and nothing
    // Google said.
    expect(row?.lastError).not.toContain("invalid_grant");
  });
});
