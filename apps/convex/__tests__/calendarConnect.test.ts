/**
 * Attaching Calendar as a product on the shared Google connection.
 *
 * Same shape as `googleConnect.test.ts` and the same reason: every control
 * here — the flag, the personal-context-only rule, the redirect pin,
 * single-use attempt consumption — could be deleted with the rest of the
 * suite green unless a test names the sabotage it catches. This file adds
 * only what `calendarConnect.ts` adds on top: no new table, a second flag
 * with its own gate, and the scope-union fix.
 *
 * **The one thing this file exists to prove, twice, at two different
 * layers**: adding Calendar to an account that already has Gmail must not
 * silently drop Gmail's access. `describe("the scope-union fix")` proves the
 * *request* asks for both (the half this module's own code controls);
 * `describe("the row shape")`'s reconnect tests prove the *binding* never
 * writes a stale slice for a product this bind was not about, in either
 * direction — the same "two views of one fact, never two facts" rule
 * `googleConnect.test.ts` already holds `applyGmailConnectionBinding` to,
 * applied here to `applyCalendarConnectionBinding` as well.
 */

import { describe, expect, test, vi, afterEach } from "vitest";
import { api, internal } from "../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../functions/lib/crypto";
import type { Id } from "../_generated/dataModel";

const APP = "https://app.context.invalid";
const REDIRECT = `${APP}/calendar/google/callback`;
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

afterEach(() => {
  vi.unstubAllEnvs();
});

function enableCalendarConnect() {
  vi.stubEnv("CALENDAR_CONNECT_ENABLED", "true");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
}

/** Gmail's own flag, for the fixture that needs a real Gmail bind alongside Calendar's flow. */
function enableMailConnect() {
  vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
}

async function personalScenario() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  return { t, owner, workspaceId };
}

async function sharedScenario() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas-team", { kind: "shared" });
  return { t, owner, workspaceId };
}

/** Standard args for `applyGmailConnectionBinding`, mirroring `googleConnect.test.ts`'s own helper. */
function gmailBindingArgs(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    address: "person@example.invalid",
    mailboxSlug: "person-at-example-invalid",
    googleAccountId: "google-1",
    scopes: [GMAIL_SCOPE],
    backfillDays: 90,
    folders: ["inbox", "sent"] as ("inbox" | "sent")[],
    attachmentMode: "store" as const,
    attachmentRetentionDays: 90,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

/** Bind a Gmail connection directly — no network, exactly like `googleConnect.test.ts`'s own fixtures. */
async function bindGmail(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  boundBy: Id<"users">,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const keyset = requireKeyset();
  const context = { workspaceId: workspaceId as string };
  await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
    workspaceId,
    boundBy,
    ...gmailBindingArgs(overrides),
    encryptedRefreshToken: await encryptSecret("refresh-gmail", keyset, context),
    encryptedAccessToken: await encryptSecret("access-gmail", keyset, context),
  });
}

async function connectionRow(t: TestConvex, workspaceId: Id<"workspaces">, address: string) {
  return t.run((ctx) =>
    ctx.db
      .query("googleConnections")
      .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
      .unique(),
  );
}

/** Standard args for `applyCalendarConnectionBinding`. */
function calendarBindingArgs(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    address: "person@example.invalid",
    googleAccountId: "google-1",
    scopes: [CALENDAR_SCOPE],
    accessTokenExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

async function bindCalendar(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  boundBy: Id<"users">,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const keyset = requireKeyset();
  const context = { workspaceId: workspaceId as string };
  await t.mutation(internal.functions.calendarConnect.applyCalendarConnectionBinding, {
    workspaceId,
    boundBy,
    ...calendarBindingArgs(overrides),
    encryptedRefreshToken: await encryptSecret("refresh-calendar", keyset, context),
    encryptedAccessToken: await encryptSecret("access-calendar", keyset, context),
  });
}

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
    expect(scopes).toContain(CALENDAR_SCOPE);
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
  test("a Calendar bind that loses Gmail's scope marks the connection as needing a reconnect", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    enableMailConnect();
    await bindGmail(t, workspaceId, owner);
    const healthy = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(healthy?.health).toBe("backfilling");

    await bindCalendar(t, workspaceId, owner, { scopes: [CALENDAR_SCOPE] });

    const row = await connectionRow(t, workspaceId, "person@example.invalid");
    expect(row?.gmail?.scopes).toEqual([]);
    expect(row?.health).toBe("reconnect_required");
    expect(row?.errorCode).toBe("SCOPES_INCOMPLETE");
    // The message names the remedy and carries nothing Google said.
    expect(row?.lastError).toContain("Reconnect");
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
    expect(scopes).toContain(CALENDAR_SCOPE);
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
