import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../../functions/lib/crypto";
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

describe("isolation: no cross-workspace leak through the shared connection table", () => {
  test("one workspace's Calendar connection never appears when another workspace is queried", async () => {
    const { t, owner: ownerA, workspaceId: workspaceA } = await personalScenario();
    const ownerB = await createUser(t, "ownerb@example.invalid");
    const workspaceB = await createWorkspace(t, ownerB, "atlas-b");

    await bindCalendar(t, workspaceA, ownerA, { address: "a@example.invalid", googleAccountId: "google-a" });
    await bindCalendar(t, workspaceB, ownerB, { address: "b@example.invalid", googleAccountId: "google-b" });

    const rowsForA = await t.run((ctx) =>
      ctx.db.query("googleConnections").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceA)).collect(),
    );
    expect(rowsForA).toHaveLength(1);
    expect(rowsForA[0]?.address).toBe("a@example.invalid");
  });
});

/**
 * ADVERSARIAL REVIEW OF PR #344.
 *
 * Everything below was added by review, not by the author, and each block
 * names the attack it refuses rather than the feature it exercises.
 *
 * The rule the isolation tests here follow — learned from the Gmail
 * review, where three guards passed for the wrong reason — is that
 * **attacker and victim live in ONE database**. A test that builds the
 * victim in a second `setupTest()` proves only that a row absent from the
 * attacker's own database cannot be read, which is true of any code at all,
 * including code with no authorization check whatsoever.
 */
describe("attacker and victim in the same database", () => {
  /** Two personal contexts, two owners, one database. The attacker owns nothing of the victim's. */
  async function twoTenants() {
    const t = setupTest();
    const victim = await createUser(t, "victim@example.invalid");
    const victimWorkspace = await createWorkspace(t, victim, "victim-workspace");
    const attacker = await createUser(t, "attacker@example.invalid");
    const attackerWorkspace = await createWorkspace(t, attacker, "attacker-workspace");
    return { t, victim, victimWorkspace, attacker, attackerWorkspace };
  }

  test("a stranger cannot start a Calendar connect against somebody else's workspace", async () => {
    enableCalendarConnect();
    const { t, attacker, victimWorkspace } = await twoTenants();

    const error = await captureError(() =>
      asUser(t, attacker).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId: victimWorkspace,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
    // And nothing was parked in the victim's name — a refusal that still
    // wrote a row would let a stranger burn the victim's attempt table.
    const attempts = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(attempts).toHaveLength(0);
  });

  test("...and the refusal is the same one a workspace that no longer exists gets, so it tells them nothing", async () => {
    enableCalendarConnect();
    const { t, attacker, victimWorkspace, attackerWorkspace } = await twoTenants();
    // Delete the attacker's own workspace so the id is real but resolves to
    // nothing: the two refusals must be indistinguishable.
    await t.run((ctx) => ctx.db.delete(attackerWorkspace));

    const onVictim = await captureError(() =>
      asUser(t, attacker).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId: victimWorkspace,
        redirectUri: REDIRECT,
      }),
    );
    const onNothing = await captureError(() =>
      asUser(t, attacker).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId: attackerWorkspace,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(onVictim)).toBe(errorCode(onNothing));
  });

  test("the scope union is read from the CALLER'S workspace, never from every row in the table", async () => {
    enableCalendarConnect();
    enableMailConnect();
    const { t, victim, victimWorkspace, attacker, attackerWorkspace } = await twoTenants();
    // The victim has Gmail connected. The attacker has nothing.
    await bindGmail(t, victimWorkspace, victim);

    const result = await asUser(t, attacker).action(api.functions.calendarConnect.startCalendarConnect, {
      workspaceId: attackerWorkspace,
      redirectUri: REDIRECT,
    });
    const scopes = (new URL(result.authorizeUrl).searchParams.get("scope") ?? "").split(" ");
    // `findSingleConnectionForWorkspace` must be scoped by workspace: an
    // unscoped `.collect()` would find the victim's single row, request
    // Gmail's scope on the attacker's consent screen, and park an attempt
    // claiming a product the attacker never had.
    expect(scopes).not.toContain(GMAIL_SCOPE);
    expect(scopes).toContain(CALENDAR_REQUEST_SCOPE);
    const attempts = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(attempts[0]?.products).toEqual(["calendar"]);
  });

  test("a Calendar connection cannot be disconnected by a stranger holding its id", async () => {
    const { t, victim, victimWorkspace, attacker, attackerWorkspace } = await twoTenants();
    await bindCalendar(t, victimWorkspace, victim, { address: "victim@gmail.invalid" });
    const connectionId = (await connectionRow(t, victimWorkspace, "victim@gmail.invalid"))!._id;

    // Their own workspace, the victim's connection id.
    const crossed = await captureError(() =>
      asUser(t, attacker).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
        workspaceId: attackerWorkspace,
        connectionId,
      }),
    );
    expect(errorCode(crossed)).toBe("NOT_FOUND");

    // The victim's workspace and the victim's connection id — the attacker
    // supplying both halves correctly and simply not being a member.
    const impersonated = await captureError(() =>
      asUser(t, attacker).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
        workspaceId: victimWorkspace,
        connectionId,
      }),
    );
    expect(errorCode(impersonated)).toBe("NOT_OWNER");

    // Neither attempt touched the credential or the connection's state.
    const row = await connectionRow(t, victimWorkspace, "victim@gmail.invalid");
    expect(row?.disconnectedAt).toBeUndefined();
    expect(row?.encryptedRefreshToken.length).toBeGreaterThan(0);
  });

  test("a member of the victim's own context still cannot disconnect it — read access is never write access", async () => {
    const { t, victim, victimWorkspace } = await twoTenants();
    const reader = await createUser(t, "reader@example.invalid");
    await addMember(t, victimWorkspace, reader, "member");
    await bindCalendar(t, victimWorkspace, victim, { address: "victim@gmail.invalid" });
    const connectionId = (await connectionRow(t, victimWorkspace, "victim@gmail.invalid"))!._id;

    const error = await captureError(() =>
      asUser(t, reader).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
        workspaceId: victimWorkspace,
        connectionId,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
    expect((await connectionRow(t, victimWorkspace, "victim@gmail.invalid"))?.disconnectedAt).toBeUndefined();
  });

  test("one workspace's calendar connect never writes into another's row, even on the same Google address", async () => {
    const { t, victim, victimWorkspace, attacker, attackerWorkspace } = await twoTenants();
    // The same address on both sides: `(workspaceId, address)` is the key,
    // so this must be two rows, not one shared one.
    await bindCalendar(t, victimWorkspace, victim, { address: "shared@example.invalid", googleAccountId: "google-v" });
    await bindCalendar(t, attackerWorkspace, attacker, { address: "shared@example.invalid", googleAccountId: "google-a" });

    const victimRow = await connectionRow(t, victimWorkspace, "shared@example.invalid");
    const attackerRow = await connectionRow(t, attackerWorkspace, "shared@example.invalid");
    expect(victimRow?._id).not.toBe(attackerRow?._id);
    expect(victimRow?.googleAccountId).toBe("google-v");
    expect(attackerRow?.googleAccountId).toBe("google-a");
    expect(victimRow?.workspaceId).toBe(victimWorkspace);
  });
});

describe("an attempt is for the products it parked", () => {
  /**
   * `googleConnectAttempts` is ONE table for every product's connect flow,
   * and neither `complete*Connect` used to look at `products`. So a state
   * parked by `startGmailConnect` could be answered on Calendar's callback
   * — adding `calendar` to the row out of a consent screen that never
   * mentioned a calendar — and a Calendar attempt could be answered on
   * Gmail's, binding a mailbox with a default 90-day backfill out of a
   * consent screen that never mentioned mail. Found by review; both
   * directions refused, and both refusals are the ordinary
   * `CONNECT_ATTEMPT_INVALID`, which tells a caller nothing about which
   * flow parked what.
   */
  /** The secret a real starting browser keeps and hands back at completion. */
  const CAL_COMPLETION = "calendar-completion-secret-0123456789";

  async function parkAttemptFor(
    t: TestConvex,
    workspaceId: Id<"workspaces">,
    startedBy: Id<"users">,
    products: ("gmail" | "calendar" | "chat")[],
    state: string,
  ) {
    const keyset = requireKeyset();
    await t.run(async (ctx) => {
      await ctx.db.insert("googleConnectAttempts", {
        workspaceId,
        startedBy,
        hashedState: await hashToken(state),
        encryptedVerifier: await encryptSecret("verifier", keyset, { workspaceId: workspaceId as string }),
        redirectUri: REDIRECT,
        hashedCompletion: await hashToken(CAL_COMPLETION),
        products,
        expiresAt: Date.now() + 600_000,
        createdAt: Date.now(),
      });
    });
  }

  test("a Gmail-only attempt cannot be completed as a Calendar connect", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const state = "gmail-parked-state-0123456789";
    await parkAttemptFor(t, workspaceId, owner, ["gmail"], state);

    const error = await captureError(() =>
      /*
        THE SECRET IS PASSED, AND THAT IS WHAT MAKES THIS A TEST OF THE PRODUCT
        CHECK. The browser binding is checked first, so a call that omits it is
        refused before `products` is ever read — the assertion would still pass
        and would be proving something else entirely. Measured: with the secret
        left out, deleting `!attempt.products.includes(...)` from all three
        Google flows left the whole convex suite green.
      */
      t.action(api.functions.calendarConnect.completeCalendarConnect, {
        state,
        code: "code",
        completionSecret: CAL_COMPLETION,
      }),
    );
    expect(errorCode(error)).toBe("CONNECT_ATTEMPT_INVALID");
    // Spent either way — a refused attempt is still a burned one.
    expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(0);
    // And nothing was scheduled that would have written a row.
    expect(await t.run((ctx) => ctx.db.query("googleConnections").collect())).toHaveLength(0);
  });

  test("a Calendar-only attempt cannot be completed as a Gmail connect either", async () => {
    enableCalendarConnect();
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const state = "calendar-parked-state-0123456789";
    await parkAttemptFor(t, workspaceId, owner, ["calendar"], state);

    const error = await captureError(() =>
      // With the secret, for the reason the sibling above gives: without it
      // this refusal is the binding's, and Gmail's `products` check — the only
      // test in the tree that covers it — would be testing nothing.
      t.action(api.functions.googleConnect.completeGmailConnect, {
        state,
        code: "code",
        completionSecret: CAL_COMPLETION,
      }),
    );
    expect(errorCode(error)).toBe("CONNECT_ATTEMPT_INVALID");
    expect(await t.run((ctx) => ctx.db.query("googleConnections").collect())).toHaveLength(0);
  });

  test("an attempt for both products is answerable by either flow — the union case is not collateral damage", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const state = "union-parked-state-0123456789";
    await parkAttemptFor(t, workspaceId, owner, ["gmail", "calendar"], state);

    // It gets past the attempt check and is consumed rather than refused;
    // what happens after is the exchange's business, not this check's.
    const consumed = await t.mutation(internal.functions.calendarConnect.consumeCalendarAttemptAndExchange, {
      hashedState: await hashToken(state),
      code: "code",
      hashedCompletion: await hashToken(CAL_COMPLETION),
    });
    expect(consumed?.workspaceId).toBe(workspaceId);
  });

    /**
     * The third flow to carry this shape, and the second to inherit it from a
     * sibling. `completeCalendarConnect` is a public action taking
     * `{state, code}` with no session and, until this, nothing tying the
     * completion to the browser that started it.
     *
     * `state` travels in the authorize URL and comes back in the callback, so
     * whoever built that URL knows it — including somebody who built it for a
     * workspace they really do own and sent it to another person to consent.
     * PKCE cannot see that: the attacker is the *initiator*, so the verifier is
     * genuinely theirs and matches. The product check this file already makes is
     * orthogonal — it stops a Calendar attempt binding Gmail, not somebody
     * else's Google account binding to the attacker's context.
     *
     * Still no session, for `#76`'s reason: a sign-in wall on a callback
     * outlives a provider's single-use code.
     */
    test("A COMPLETION WITHOUT THE STARTING BROWSER'S SECRET IS REFUSED", async () => {
      enableCalendarConnect();
      const { t, owner, workspaceId } = await personalScenario();
      const state = "calendar-binding-state-0123456789";
      await parkAttemptFor(t, workspaceId, owner, ["calendar"], state);

      const consumed = await t.mutation(
        internal.functions.calendarConnect.consumeCalendarAttemptAndExchange,
        {
          hashedState: await hashToken(state),
          code: "code",
          hashedCompletion: await hashToken("a-guess"),
        },
      );
      expect(consumed).toBeNull();
    });

    test("...and the secret the starter kept does complete it", async () => {
      enableCalendarConnect();
      const { t, owner, workspaceId } = await personalScenario();
      const state = "calendar-binding-state-ok-0123456789";
      await parkAttemptFor(t, workspaceId, owner, ["calendar"], state);

      const consumed = await t.mutation(
        internal.functions.calendarConnect.consumeCalendarAttemptAndExchange,
        {
          hashedState: await hashToken(state),
          code: "code",
          hashedCompletion: await hashToken(CAL_COMPLETION),
        },
      );
      expect(consumed?.workspaceId).toBe(workspaceId);
    });
});

describe("a grant that does not cover every product says so where somebody looks", () => {
  /**
   * The half of the scope-union problem the author's own tests stop short
   * of: the row is honest (`gmail.scopes: []`), but nothing reads a scope
   * slice, so on its own that fact is written and never spoken. A mail sync
   * would go on being scheduled against a grant that cannot answer, getting
   * 403s from Google, while the console shows the connection as fine.
   */
  test("a Calendar bind that loses the Calendar read marks the connection as needing a reconnect", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);
    const healthy = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(healthy?.health).toBe("backfilling");

    await bindCalendar(t, workspaceId, owner, { scopes: [] });

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.health).toBe("reconnect_required");
    expect(row?.errorCode).toBe("SCOPES_INCOMPLETE");
    // The message names the remedy and carries nothing Google said.
    expect(row?.lastError).toContain("Reconnect");
  });

  // A row made before the minimum consent whose grant no longer covers Gmail
  // the old way: a reconnect under the minimum could not mend it, so the row
  // moves to the minimum consent and AI waits for the person's AI consent
  // instead (`lib/googleConnect/consentPlan.ts`).
  test("a Calendar bind that loses Gmail's scope on a row made before moves it to the minimum consent, not to a reconnect", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);
    const made = await connectionRow(t, workspaceId, "person@example.invalid");
    await t.run((ctx) => ctx.db.patch(made!._id, { consentPlan: undefined }));

    await bindCalendar(t, workspaceId, owner, { scopes: [CALENDAR_SCOPE] });

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.gmail?.scopes).toEqual([]);
    expect(row?.consentPlan).toBe("split");
    expect(row?.health).not.toBe("reconnect_required");
  });

  test("...and a grant that covers both leaves the health alone, exactly as before", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);

    await bindCalendar(t, workspaceId, owner, { scopes: [GMAIL_SCOPE, CALENDAR_SCOPE] });

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.health).toBe("backfilling");
    expect(row?.errorCode).toBeUndefined();
  });

  test("a Calendar connect whose grant carries no calendar scope at all is not reported as connected and working", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    // The person unchecks the calendar box on Google's consent screen.
    await bindCalendar(t, workspaceId, owner, { scopes: [] });

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.products).toEqual(["calendar"]);
    expect(row?.calendar?.scopes).toEqual([]);
    expect(row?.health).toBe("reconnect_required");
  });

  test("reconnecting a DISCONNECTED account through Calendar makes it healthy again, not silently still broken", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    await bindCalendar(t, workspaceId, owner);
    // What `disconnectGoogleConnection` leaves behind: health "error", a
    // disconnect timestamp, and an emptied credential.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", "person@example.invalid"))
        .unique();
      await ctx.db.patch(row!._id, { health: "error", disconnectedAt: Date.now(), encryptedRefreshToken: "" });
    });

    await bindCalendar(t, workspaceId, owner);

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.disconnectedAt).toBeUndefined();
    expect(row?.encryptedRefreshToken.length).toBeGreaterThan(0);
    // Before this fix: a live connection reporting "error" forever, with no
    // error code to explain it and nothing but a Gmail reconnect to clear it.
    expect(row?.health).toBe("active");
  });
});

describe("nothing about a failed connect leaks", () => {
  test("a connect failure records no message, no code, no verifier — only which workspace and a classified code", async () => {
    const { t, workspaceId } = await personalScenario();
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      await t.mutation(internal.functions.calendarConnect.recordCalendarConnectFailure, {
        workspaceId,
        errorCode: "CALENDAR_EXCHANGE_FAILED",
        // Everything Google might have said, plus the shapes of the secrets
        // that travel through this flow.
        message: "invalid_grant: code 4/0AY0e-g7 verifier dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      });
    } finally {
      console.log = original;
    }
    const line = logs.join("\n");
    expect(line).toContain("calendar.connect_failed");
    expect(line).toContain(workspaceId);
    expect(line).not.toContain("4/0AY0e-g7");
    expect(line).not.toContain("dBjftJeZ4CVP");
    expect(line).not.toContain("invalid_grant");
  });

  test("the audit row a Calendar connect writes carries the address and nothing else about the grant", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    await bindCalendar(t, workspaceId, owner);

    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    const connected = events.filter((event) => event.action === "calendar.connected");
    expect(connected).toHaveLength(1);
    const serialized = JSON.stringify(connected[0]);
    expect(serialized).toContain("person@example.invalid");
    // The two encrypted envelopes and the scope list stay out of the trail.
    expect(serialized).not.toContain("refresh-calendar");
    expect(serialized).not.toContain("access-calendar");
    expect(serialized.toLowerCase()).not.toContain("token");
  });
});

describe("an editor is not an owner, and that is what the guards actually refuse", () => {
  /**
   * The class of mistake the Gmail review found: a guard that reads as an
   * ownership check but is only ever driven by a caller with NO membership
   * at all passes just as happily with the role comparison deleted. Every
   * refusal below is driven by a real member of the very workspace being
   * attacked, in one database.
   */
  test("an editor of this personal context cannot start a Calendar connect", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor");

    const error = await captureError(() =>
      asUser(t, editor).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
    expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(0);
    // And the owner, in the same database, still can — so the refusal is
    // about the role and not about the workspace being unreachable.
    expect(
      (
        await asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
          workspaceId,
          redirectUri: REDIRECT,
        })
      ).authorizeUrl,
    ).toContain("https://accounts.google.com/");
  });

  test("an editor cannot disconnect the Google account either", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor");
    await bindCalendar(t, workspaceId, owner);
    const connectionId = (await connectionRow(t, workspaceId, "person@example.invalid"))!._id;

    const error = await captureError(() =>
      asUser(t, editor).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
        workspaceId,
        connectionId,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
    expect((await connectionRow(t, workspaceId, "person@example.invalid"))?.disconnectedAt).toBeUndefined();

    // The owner of the same context, same database, same connection id, does
    // disconnect it — which is what makes the refusal above a role check.
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId,
    });
    expect((await connectionRow(t, workspaceId, "person@example.invalid"))?.disconnectedAt).toBeDefined();
  });
});

describe("a calendar connection records the folder it files into", () => {
  /*
    Calendar's half of the rule stated in full in `chatProduct.test.ts`,
    "a connection records the folder it files into": the folder a customer's
    days are written to is a fact about the connection, recorded once, not a
    constant every pass re-reads. Gmail has always pinned it at connect;
    Calendar stored nothing, so `defaultGoogleDestinationFolder("calendar")`
    decided — in source — where already-connected customers' calendars land,
    and editing it would relocate them.
  */
  test("a first calendar connect records its destination folder on the row", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    await bindCalendar(t, workspaceId, owner);

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) =>
          q.eq("workspaceId", workspaceId).eq("address", "person@example.invalid"),
        )
        .unique(),
    );
    // This account's own folder under the calendar folder, since 2026-09-18.
    // Two Google accounts used to write one file between them, which is a pair
    // of calendars no folder rule in `privacy.md` could tell apart.
    expect(row?.calendar?.destinationFolder).toBe("inbox/calendar/person-at-example-invalid");
  });

  test("a reconnect keeps a destination the owner chose", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    await bindCalendar(t, workspaceId, owner);
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) =>
          q.eq("workspaceId", workspaceId).eq("address", "person@example.invalid"),
        )
        .unique(),
    );
    await asUser(t, owner).mutation(api.functions.googleConnect.updateGoogleSyncDestination, {
      workspaceId,
      connectionId: connection!._id,
      service: "calendar",
      destinationPath: "2-areas/calendar",
    });
    await bindCalendar(t, workspaceId, owner);

    const row = await t.run((ctx) => ctx.db.get(connection!._id));
    expect(row?.calendar?.destinationFolder).toBe("2-areas/calendar");
  });
});
