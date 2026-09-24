import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  errorCode,
} from "../fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../../functions/lib/crypto";
import {
  REDIRECT,
  GMAIL_SCOPE,
  CALENDAR_SCOPE,
  enableCalendarConnect,
  enableMailConnect,
  personalScenario,
  sharedScenario,
  bindGmail,
  connectionRow,
  bindCalendar,
} from "./fixtures.helpers";

describe("the flag — its own, not Gmail's", () => {
  test("unset refuses to start", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("CALENDAR_CONNECT_DISABLED");
  });

  test("...and refuses to answer a callback too", async () => {
    const { t } = await personalScenario();
    const error = await captureError(() =>
      t.action(api.functions.calendarConnect.completeCalendarConnect, { state: "whatever", code: "whatever" }),
    );
    expect(errorCode(error)).toBe("CALENDAR_CONNECT_DISABLED");
  });

  test("MAIL_CONNECT_ENABLED alone does not enable Calendar — the two are deliberately separate gates", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("CALENDAR_CONNECT_DISABLED");
  });

  test("the disabled deployment parks nothing", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    await captureError(() =>
      asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    const parked = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(parked).toHaveLength(0);
  });

  test("enabled but with no client id configured refuses distinctly", async () => {
    vi.stubEnv("CALENDAR_CONNECT_ENABLED", "true");
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("MAIL_CONNECT_NOT_CONFIGURED");
  });
});

describe("only a personal context may connect Calendar", () => {
  test("a shared workspace is refused, same as Gmail's own rule", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await sharedScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
  });

  test("a member who is not the owner is refused", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "editor");
    const error = await captureError(() =>
      asUser(t, member).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
  });

  test("the owner may start", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const result = await asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    expect(result.authorizeUrl).toContain("https://accounts.google.com/");
  });
});

describe("which redirect URIs this deployment answers on", () => {
  test("a redirect to an attacker's origin is refused", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId,
        redirectUri: "https://attacker.example/cb",
      }),
    );
    expect(errorCode(error)).toBe("REDIRECT_URI_NOT_ALLOWED");
  });
});

describe("the scope-union fix — request side", () => {
  /**
   * THE test the coordinator's brief asks for by name: adding Calendar to a
   * row that already has Gmail must ask Google for both, not Calendar alone
   * — otherwise the resulting grant silently stops covering Gmail (Google
   * grants exactly what is requested) and the next Gmail sync starts
   * failing with a scope it no longer has.
   *
   * Sabotage (measured, not assumed): replace `products` in
   * `startCalendarConnect` with `["calendar"]` unconditionally (drop the
   * existing-connection lookup) — 2 of these 25 tests fail: this one, on the
   * missing `gmail.readonly` scope, and the parked-attempt test just below,
   * on `products` recording `["calendar"]` instead of `["calendar", "gmail"]`.
   * The other 23, including every `include_granted_scopes` and binding test,
   * stay green — this sabotage isolates the request-side fix specifically.
   */
  test("starting a Calendar connect on an account that already has Gmail requests both scopes, not Calendar alone", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);

    const result = await asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    const url = new URL(result.authorizeUrl);
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");
    expect(scopes).toContain(GMAIL_SCOPE);
    expect(scopes).toContain(CALENDAR_SCOPE);
  });

  test("...and the parked attempt records both products, so a completed exchange knows what was intended", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);

    await asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    const attempt = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(attempt).toHaveLength(1);
    expect(attempt[0]?.products.sort()).toEqual(["calendar", "gmail"]);
  });

  test("a first-ever connect (no existing row) requests Calendar alone — there is nothing to union with", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const result = await asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    const url = new URL(result.authorizeUrl);
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");
    expect(scopes).toContain(CALENDAR_SCOPE);
    expect(scopes).not.toContain(GMAIL_SCOPE);
  });

  // Sabotage, measured: removing `include_granted_scopes=true` from
  // `googleAuthorizeUrl` fails this test and
  // `googleOAuth.test.ts`'s own "always requests the union..." test — 2
  // failures total, both isolating this one line — the other 63 tests in
  // the two files stay green.
  test("also carries include_granted_scopes — belt and suspenders for the ambiguous case this module cannot see in advance", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const result = await asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    const url = new URL(result.authorizeUrl);
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });

  test("two existing connections for one workspace is ambiguous, and this module does not guess which to extend", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner, { address: "one@example.invalid", mailboxSlug: "one-at-example-invalid" });
    await bindGmail(t, workspaceId, owner, { address: "two@example.invalid", mailboxSlug: "two-at-example-invalid" });

    const result = await asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    const url = new URL(result.authorizeUrl);
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");
    // Not unioned with either — but `include_granted_scopes=true` is still
    // on the URL (checked above), which is what still protects whichever
    // account the person actually picks in Google's chooser.
    expect(scopes).not.toContain(GMAIL_SCOPE);
    expect(scopes).toContain(CALENDAR_SCOPE);
  });
});

describe("the row shape: products and the nested calendar object", () => {
  test("a first connect writes products: ['calendar'] and no gmail object", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    await bindCalendar(t, workspaceId, owner);

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.provider).toBe("google");
    expect(row?.products).toEqual(["calendar"]);
    expect(row?.gmail).toBeUndefined();
    expect(row?.health).toBe("active");
    expect(row?.scopes).toEqual([CALENDAR_SCOPE]);
    expect(row?.calendar?.scopes).toEqual([CALENDAR_SCOPE]);
    expect(row?.calendar?.syncToken).toBeUndefined();
  });

  /**
   * THE OTHER HALF OF "LEAVES GMAIL WORKING": once bound, the row's Gmail
   * settings (its folder slug, its backfill choices) are untouched by a
   * Calendar bind, and — this is the part that actually answers "does Gmail
   * still work" — its scope slice still contains `gmail.readonly`, proving
   * the grant this bind received really did cover both products.
   */
  test("binding Calendar onto an account that already has Gmail leaves Gmail's settings and scopes intact", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);

    // The realistic outcome of the request-side fix: Google's grant now
    // covers both products, verbatim.
    await bindCalendar(t, workspaceId, owner, { scopes: [GMAIL_SCOPE, CALENDAR_SCOPE] });

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.products.sort()).toEqual(["calendar", "gmail"]);
    expect(row?.gmail?.mailboxSlug).toBe("person-at-example-invalid");
    expect(row?.gmail?.backfillDays).toBe(90);
    expect(row?.gmail?.scopes).toEqual([GMAIL_SCOPE]);
    expect(row?.calendar?.scopes).toEqual([CALENDAR_SCOPE]);
    expect(row?.scopes.sort()).toEqual([CALENDAR_SCOPE, GMAIL_SCOPE].sort());
  });

  /**
   * Sabotage: this is the failure the coordinator's brief describes by name
   * — a Calendar bind that received a narrow grant (the union-request fix
   * did not run, or Google ignored `include_granted_scopes`) must show up
   * as an honest empty Gmail slice, not a Calendar connection that silently
   * broke Gmail while the row still claims it works.
   *
   * Measured, not assumed: reverting `applyCalendarConnectionBinding`'s
   * `gmail: existing?.gmail ? { ...existing.gmail, scopes: grantedScopesFor(...) } : undefined`
   * to the naive `gmail: existing?.gmail` fails exactly this test and the
   * reconnect-symmetry test below — 2 of 25 — leaving stale scopes claiming
   * a consent the new grant does not carry; the other 23 stay green.
   */
  test("if the grant Calendar receives does NOT cover Gmail, the row says so honestly rather than hiding it", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);

    // The failure the coordinator's brief describes: the fix did not run
    // (or Google ignored include_granted_scopes), so the grant that came
    // back is Calendar-only.
    await bindCalendar(t, workspaceId, owner, { scopes: [CALENDAR_SCOPE] });

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.scopes).toEqual([CALENDAR_SCOPE]);
    // The slice is empty because the grant no longer carries it — not stale.
    expect(row?.gmail?.scopes).toEqual([]);
    // And no product's slice claims a scope the account's own list does not.
    for (const slice of [row?.gmail?.scopes ?? [], row?.calendar?.scopes ?? []]) {
      for (const scope of slice) expect(row?.scopes).toContain(scope);
    }
  });

  /**
   * "Two views of one fact, never two facts" — the exact rule
   * `googleConnect.test.ts` proves for a Gmail-only reconnect, proved here
   * in the direction that module's own comment named as outstanding: a
   * Calendar-only reconnect must not leave Gmail's slice stale either.
   *
   * Sabotage: change `gmail: existing?.gmail ? {...} : undefined` back to
   * `gmail: existing?.gmail` (carry it through untouched) — measured: this
   * and the test above are the 2 of 25 that fail (see that test's comment
   * for the full count).
   */
  test("a Calendar-only reconnect recomputes Gmail's scope slice too, not only Calendar's", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);
    await bindCalendar(t, workspaceId, owner, { scopes: [GMAIL_SCOPE, CALENDAR_SCOPE] });

    // The person re-consents and this time Google (or the person, unchecking
    // a box) narrows the grant to Calendar alone.
    await bindCalendar(t, workspaceId, owner, { scopes: [CALENDAR_SCOPE] });

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.scopes).toEqual([CALENDAR_SCOPE]);
    expect(row?.gmail?.scopes).toEqual([]);
    expect(row?.calendar?.scopes).toEqual([CALENDAR_SCOPE]);
    // Gmail's own settings (not a scope slice) are still exactly as they were.
    expect(row?.gmail?.mailboxSlug).toBe("person-at-example-invalid");
  });

  test("reconnecting Calendar keeps its own cursor and destination across the reconnect", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    await bindCalendar(t, workspaceId, owner);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", "person@example.invalid"))
        .unique();
      await ctx.db.patch(row!._id, {
        calendar: {
          ...row!.calendar!,
          syncToken: "cal-token-abc",
          destinationFolder: "2-areas/communications/daily",
        },
      });
    });

    await bindCalendar(t, workspaceId, owner);

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.calendar?.syncToken).toBe("cal-token-abc");
    expect(row?.calendar?.destinationFolder).toBe("2-areas/communications/daily");
  });

  test("reconnecting Calendar never touches Gmail's own settings, folder slug included", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);
    await bindCalendar(t, workspaceId, owner);
    await bindCalendar(t, workspaceId, owner);

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.gmail?.mailboxSlug).toBe("person-at-example-invalid");
    expect(row?.gmail?.folders).toEqual(["inbox", "sent"]);
  });

  test("reconnecting clears disconnectedAt", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    await bindCalendar(t, workspaceId, owner);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", "person@example.invalid"))
        .unique();
      await ctx.db.patch(row!._id, { disconnectedAt: Date.now() });
    });

    await bindCalendar(t, workspaceId, owner);

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.disconnectedAt).toBeUndefined();
  });

  test("an existing connection's health (Gmail's own backfilling state machine) is untouched by a Calendar bind", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", "person@example.invalid"))
        .unique();
      await ctx.db.patch(row!._id, { health: "error", lastError: "gmail sync hiccup", errorCode: "SOMETHING" });
    });

    // A Calendar bind clears lastError/errorCode the same way any successful
    // bind does elsewhere in this product — but must not invent a health
    // state Gmail's own sync process did not report.
    await bindCalendar(t, workspaceId, owner, { scopes: [GMAIL_SCOPE, CALENDAR_SCOPE] });

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.health).toBe("error");
  });
});

describe("who may answer a callback", () => {
  test("an unknown state is refused", async () => {
    enableCalendarConnect();
    const { t } = await personalScenario();
    const error = await captureError(() =>
      t.action(api.functions.calendarConnect.completeCalendarConnect, {
        state: "never-parked",
        code: "c",
      }),
    );
    expect(errorCode(error)).toBe("CONNECT_ATTEMPT_INVALID");
  });

  test("an expired attempt is refused and consumed", async () => {
    enableCalendarConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const state = "expired-state-0123456789";
    const keyset = requireKeyset();
    await t.run(async (ctx) => {
      await ctx.db.insert("googleConnectAttempts", {
        workspaceId,
        startedBy: owner,
        hashedState: await hashToken(state),
        encryptedVerifier: await encryptSecret("v", keyset, { workspaceId: workspaceId as string }),
        redirectUri: REDIRECT,
        products: ["calendar"],
        expiresAt: Date.now() - 1000,
        createdAt: Date.now() - 700_000,
      });
    });
    const error = await captureError(() =>
      t.action(api.functions.calendarConnect.completeCalendarConnect, { state, code: "c" }),
    );
    expect(errorCode(error)).toBe("CONNECT_ATTEMPT_INVALID");
    const remaining = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(remaining).toHaveLength(0);
  });
});

