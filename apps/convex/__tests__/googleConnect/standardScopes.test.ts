/**
 * The standard client's least scope, and AI reads from the grant AI mints
 * from (`functions/lib/googleConnect/aiScopes.ts`; agent scopes and AI's
 * write capabilities are covered in clientRoles.test.ts).
 *
 * Every new standard consent is identity plus the Meetings view's owned
 * calendar read (2026-10-30), whatever the switch says. Once a row runs
 * switched (`GOOGLE_AGENT_CLIENT_ACTIVE`, the canary, or a row made under the
 * minimum consent), a connect binds Gmail and Chat by the person's choice
 * rather than by reads the standard grant no longer carries.
 *
 * Sabotage (temporary local edits, reverted): `standardScopesFor` asking the
 * broad pair fails "identity, plus the owned calendar read ...";
 * `standardGrantCovers` ignoring the switch fails "after the switch a Gmail
 * connect binds ..."; `standardGrantCovers` dropping the Calendar exception
 * fails "after the switch Calendar still needs ..."; the read routes using
 * `row.scopes` in place of `aiScopesOf` fail "an agent grant that does not
 * read the calendar ..." and "after the switch a connection without AI
 * access ...".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import { encryptSecret, hashToken, requireKeyset } from "../../functions/lib/crypto";
import {
  CALENDAR_SCOPES,
  CALENDAR_WRITE_SCOPE,
  CHAT_READ_SCOPES,
  GMAIL_SCOPES,
  CALENDAR_OWNED_READ_SCOPE,
  IDENTITY_SCOPES,
} from "../../functions/lib/googleOAuth";
import { canReadProduct, standardGrantCovers, standardScopesFor } from "../../functions/lib/googleConnect/aiScopes";
import { seedGoogleConnection } from "../fixtures.helpers";
import { ACCESS_A, twoConnectedTenants } from "../controlPlane/fixtures.helpers";
import { gmailBindingArgs, personalScenario } from "./fixtures.helpers";

const AGENT_ID = "agent-client.apps.googleusercontent.example";
const CALENDAR_READ = CALENDAR_SCOPES[0];
const OFF = { GOOGLE_AGENT_CLIENT_ACTIVE: "" };
const ROLLOUT = { GOOGLE_AGENT_OAUTH_CLIENT_ID: AGENT_ID, GOOGLE_AGENT_CLIENT_ACTIVE: "" };
const SWITCHED = { GOOGLE_AGENT_OAUTH_CLIENT_ID: AGENT_ID, GOOGLE_AGENT_CLIENT_ACTIVE: "true" };

afterEach(() => {
  vi.unstubAllEnvs();
});

function configure(env: Record<string, string>) {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "standard-client.apps.googleusercontent.example");
  vi.stubEnv("GOOGLE_AGENT_OAUTH_CLIENT_ID", env.GOOGLE_AGENT_OAUTH_CLIENT_ID ?? "");
  vi.stubEnv("GOOGLE_AGENT_CLIENT_ACTIVE", env.GOOGLE_AGENT_CLIENT_ACTIVE ?? "");
}

describe("what the standard consent asks for", () => {
  // Every new request, whatever the deployment's settings (2026-10-30): the
  // global switch only decides how rows made before are read.
  test("identity, plus the owned calendar read only when Calendar is connected, and never the broad pair", () => {
    for (const env of [OFF, ROLLOUT, SWITCHED]) {
      configure(env);
      expect(standardScopesFor(["gmail", "calendar", "chat"])).toEqual([...IDENTITY_SCOPES, CALENDAR_OWNED_READ_SCOPE]);
      expect(standardScopesFor(["calendar"])).toEqual([...IDENTITY_SCOPES, CALENDAR_OWNED_READ_SCOPE]);
      expect(standardScopesFor(["gmail"])).toEqual([...IDENTITY_SCOPES]);
      expect(standardScopesFor(["chat"])).toEqual([...IDENTITY_SCOPES]);
      expect(standardScopesFor(["gmail", "calendar", "chat"])).not.toContain(CALENDAR_READ);
    }
  });
});

describe("what a standard grant must hold for a product to bind", () => {
  test("before the switch, the product's reads, as today", () => {
    expect(standardGrantCovers("gmail", [...IDENTITY_SCOPES], ROLLOUT)).toBe(false);
    expect(standardGrantCovers("gmail", [...IDENTITY_SCOPES, ...GMAIL_SCOPES], ROLLOUT)).toBe(true);
    expect(standardGrantCovers("chat", [...IDENTITY_SCOPES], OFF)).toBe(false);
  });

  test("after the switch Calendar still needs the calendar read; Gmail and Chat need nothing of it", () => {
    expect(standardGrantCovers("gmail", [...IDENTITY_SCOPES], SWITCHED)).toBe(true);
    expect(standardGrantCovers("chat", [...IDENTITY_SCOPES], SWITCHED)).toBe(true);
    expect(standardGrantCovers("calendar", [...IDENTITY_SCOPES], SWITCHED)).toBe(false);
    expect(standardGrantCovers("calendar", [...IDENTITY_SCOPES, CALENDAR_READ], SWITCHED)).toBe(true);
  });

  test("calendar reads under either calendar scope; Gmail and Chat need their own read scopes", () => {
    expect(canReadProduct("calendar", [CALENDAR_WRITE_SCOPE])).toBe(true);
    expect(canReadProduct("calendar", [CALENDAR_READ])).toBe(true);
    expect(canReadProduct("calendar", [...GMAIL_SCOPES])).toBe(false);
    expect(canReadProduct("gmail", ["https://www.googleapis.com/auth/gmail.compose"])).toBe(false);
    expect(canReadProduct("chat", [CHAT_READ_SCOPES[0]])).toBe(false);
    expect(canReadProduct("chat", [...CHAT_READ_SCOPES])).toBe(true);
  });
});

/** Bind a Gmail connect whose standard grant holds `scopes`, and read the row back. */
async function bindGmail(scopes: string[]) {
  const { t, owner, workspaceId } = await personalScenario();
  const keyset = requireKeyset();
  const context = { workspaceId: workspaceId as string };
  const connectionId = await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
    workspaceId,
    boundBy: owner,
    ...gmailBindingArgs({ scopes }),
    encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
    encryptedAccessToken: await encryptSecret("access-1", keyset, context),
  });
  return await t.run((ctx) => ctx.db.get(connectionId));
}

describe("binding a connect", () => {
  // A first connect binds a row under the minimum consent, which runs
  // switched whatever the deployment says (`googleConnect/consentPlan.test.ts`).
  test("before the switch too, a first Gmail connect binds on identity alone, as a row made under the minimum consent", async () => {
    configure(ROLLOUT);
    const row = await bindGmail([...IDENTITY_SCOPES]);
    expect(row).toMatchObject({ products: ["gmail"], consentPlan: "split" });
    expect(row!.health).not.toBe("reconnect_required");
  });

  test("after the switch a Gmail connect binds from the person's choice, though the standard grant holds identity only", async () => {
    configure(SWITCHED);
    const row = await bindGmail([...IDENTITY_SCOPES]);
    expect(row!.products).toEqual(["gmail"]);
    expect(row!.health).not.toBe("reconnect_required");
    expect(row!.errorCode).toBeUndefined();
    expect(row!.scopes).toEqual([...IDENTITY_SCOPES]);
  });
});

/** Alice's calendar connection: a broad standard grant, and an agent grant holding `agentScopes` (none when null). */
async function aliceCalendar(agentScopes: string[] | null) {
  const tenants = await twoConnectedTenants();
  const connectionId = await seedGoogleConnection(tenants.t, { workspaceId: tenants.aliceWs, boundBy: tenants.alice, address: "alice@gmail.example" });
  await tenants.t.run((ctx) =>
    ctx.db.patch(connectionId, {
      products: ["calendar"],
      scopes: [CALENDAR_READ, CALENDAR_WRITE_SCOPE],
      ...(agentScopes === null
        ? {}
        : { agentGrant: { encryptedRefreshToken: "sealed-agent-refresh-not-real", scopes: agentScopes, grantedAt: Date.now() } }),
    }),
  );
  // Reading the person's calendar takes a grant that reaches private notes, as in personCalendar.test.ts.
  await tenants.t.run((ctx) => ctx.db.patch(tenants.grantA, { scopes: ["context:read", "context:write", "context:private"] }));
  return { t: tenants.t, hashedAccessToken: await hashToken(ACCESS_A), expectedWorkspaceId: tenants.aliceWs as string };
}

describe("AI reads through the grant it mints from, partial consent included", () => {
  test("an agent grant of calendar.events alone reads the calendar", async () => {
    configure(ROLLOUT);
    const { t, ...args } = await aliceCalendar([CALENDAR_WRITE_SCOPE]);
    expect(await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, args)).toMatchObject({ ok: true });
  });

  // Named for Allow AI access, not a reconnect, since 2026-10-29 (`aiAccessNeeded`): a reconnect never mends an agent grant.
  test("an agent grant that does not read the calendar is named for one more consent, not read", async () => {
    configure(ROLLOUT);
    const { t, ...args } = await aliceCalendar([...GMAIL_SCOPES]);
    expect(await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, args)).toEqual({
      ok: false,
      refused: "ai_access_needed",
      aiAccess: ["alice@gmail.example"],
    });
  });

  test("a legacy connection with no agent grant reads exactly as before the switch", async () => {
    configure(ROLLOUT);
    const { t, ...args } = await aliceCalendar(null);
    expect(await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, args)).toMatchObject({ ok: true });
  });

  test("after the switch a connection without AI access gives AI nothing, its broad standard grant notwithstanding", async () => {
    configure(SWITCHED);
    const { t, ...args } = await aliceCalendar(null);
    expect(await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, args)).toEqual({
      ok: false,
      refused: "ai_access_needed",
      aiAccess: ["alice@gmail.example"],
    });
  });
});
