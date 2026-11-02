/**
 * Which consent a connection runs under (`lib/googleConnect/consentPlan.ts`,
 * `googleEnvForRow` in `lib/googleConnect/clients.ts`; 2026-10-30).
 *
 * A row bound under the minimum consent is `split`: AI reads it through the
 * agent grant or not at all, whatever the deployment's switch says, and is
 * told to wait for AI access rather than read through the standard token the
 * person gave for their own use. A row made before keeps its route (with the
 * switch off, AI through the standard grant) for as long as its grant holds
 * it, through a reconnect or an added product; nothing is revoked.
 *
 * Every test runs with the global switch OFF and no canary, the deployment as
 * it stands, so a split row's behaviour can only come from the row.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `googleEnvForRow` ignoring `consentPlan` → "a new row's AI never mints
 *     from the standard grant", "a new row without AI access waits for it"
 *     and "the app asks a new row's owner for AI access" fail.
 *  2. `planForBinding` answering `undefined` for a new row → "a first connect
 *     binds a split row ..." fails.
 *  3. `planForBinding` answering `split` for every row → "a reconnect that
 *     keeps the old grant keeps the old route" fails.
 *  4. `getConnectionForSync` leaving `consentPlan` out → "a new row's AI never
 *     mints from the standard grant" fails.
 *  5. `listGoogleConnections` reading `readOnly` while AI access is needed →
 *     "the app never shows a new row waiting for AI access as read-only"
 *     fails.
 *  6. `googleForwardSyncJob` without the AI-access skip → "sync waits for a
 *     new row's AI access ..." fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { encryptSecret, hashToken, requireKeyset } from "../../functions/lib/crypto";
import { CALENDAR_OWNED_READ_SCOPE, CALENDAR_OWNED_SCOPE, GMAIL_SCOPES, IDENTITY_SCOPES } from "../../functions/lib/googleOAuth";
import { planForBinding } from "../../functions/lib/googleConnect/consentPlan";
import { asUser, seedGoogleConnection } from "../fixtures.helpers";
import { ACCESS_A, twoConnectedTenants } from "../controlPlane/fixtures.helpers";
import { gmailBindingArgs, personalScenario } from "./fixtures.helpers";
import { legacyGrantScopes } from "./legacyScopes.helpers";

const AGENT_ID = "agent-client.apps.googleusercontent.example";
const HOUR = 60 * 60 * 1000;
const MINIMUM = [...IDENTITY_SCOPES, CALENDAR_OWNED_READ_SCOPE];

afterEach(() => {
  vi.unstubAllEnvs();
});

function switchOff() {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "standard-client.apps.googleusercontent.example");
  vi.stubEnv("GOOGLE_AGENT_OAUTH_CLIENT_ID", AGENT_ID);
  vi.stubEnv("GOOGLE_AGENT_CLIENT_ACTIVE", "");
  vi.stubEnv("GOOGLE_CALENDAR_SCOPE", "");
  vi.stubEnv("GOOGLE_CUTOVER_CANARY_WORKSPACES", "");
}

describe("the plan a binding gives a row", () => {
  const ws = "ws_example";

  test("a new row, or one revived after a disconnect, is split", () => {
    expect(planForBinding(ws, null, ["gmail", "calendar"], MINIMUM)).toEqual({ consentPlan: "split", starved: [] });
    expect(planForBinding(ws, { disconnectedAt: 1 }, ["gmail"], legacyGrantScopes(["gmail"])).consentPlan).toBe("split");
  });

  test("a row made before keeps its route while its grant holds it, and a split row stays split", () => {
    switchOff();
    expect(planForBinding(ws, {}, ["gmail", "calendar"], legacyGrantScopes(["gmail", "calendar"]))).toEqual({ consentPlan: undefined, starved: [] });
    expect(planForBinding(ws, { consentPlan: "split" }, ["gmail"], legacyGrantScopes(["gmail"])).consentPlan).toBe("split");
  });

  test("a row made before whose grant no longer holds the old route moves to split, and binds on the minimum", () => {
    switchOff();
    expect(planForBinding(ws, {}, ["gmail", "calendar"], MINIMUM)).toEqual({ consentPlan: "split", starved: [] });
    // Split still needs the Meetings view's calendar read.
    expect(planForBinding(ws, {}, ["calendar"], [...IDENTITY_SCOPES]).starved).toEqual(["calendar"]);
  });
});

describe("binding through a real connect", () => {
  test("a first connect binds a split row on the minimum consent, healthy, not waiting on a reconnect", async () => {
    switchOff();
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const sealed = await encryptSecret("not-a-real-token", keyset, { workspaceId: workspaceId as string });
    const connectionId = await t.mutation(
      internal.functions.googleConnect.applyGmailConnectionBinding,
      { ...gmailBindingArgs({ scopes: [...IDENTITY_SCOPES] }), workspaceId, boundBy: owner, encryptedRefreshToken: sealed, encryptedAccessToken: sealed },
    );
    const row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row).toMatchObject({ consentPlan: "split", products: ["gmail"] });
    expect(row?.health).not.toBe("reconnect_required");
  });

  test("a reconnect that keeps the old grant keeps the old route", async () => {
    switchOff();
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const sealed = await encryptSecret("not-a-real-token", keyset, { workspaceId: workspaceId as string });
    const binding = { ...gmailBindingArgs({ scopes: legacyGrantScopes(["gmail"]) }), workspaceId, boundBy: owner, encryptedRefreshToken: sealed, encryptedAccessToken: sealed };
    const connectionId = await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, binding);
    // Made before: no plan on the row.
    await t.run((ctx) => ctx.db.patch(connectionId, { consentPlan: undefined }));
    // Google's include_granted_scopes hands the reconnect every scope the account already gave.
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, { ...binding, scopes: [...legacyGrantScopes(["gmail"])] });
    expect((await t.run((ctx) => ctx.db.get(connectionId)))?.consentPlan).toBeUndefined();
  });
});

/** Alice's Google connection, with a standard token cached and no agent grant. */
async function alice(consentPlan: "split" | undefined) {
  switchOff();
  const tenants = await twoConnectedTenants();
  const connectionId: Id<"googleConnections"> = await seedGoogleConnection(tenants.t, { workspaceId: tenants.aliceWs, boundBy: tenants.alice, address: "alice@gmail.example" });
  const standardAccess = await encryptSecret("standard-access-token", requireKeyset(), { workspaceId: tenants.aliceWs as string });
  await tenants.t.run(async (ctx) => {
    await ctx.db.patch(connectionId, {
      products: ["gmail", "calendar"],
      scopes: consentPlan === "split" ? MINIMUM : legacyGrantScopes(["gmail", "calendar"]),
      consentPlan,
      encryptedAccessToken: standardAccess,
      accessTokenExpiresAt: Date.now() + HOUR,
    });
    await ctx.db.patch(tenants.grantA, { scopes: ["context:read", "context:write", "context:private"] });
  });
  const args = { hashedAccessToken: await hashToken(ACCESS_A), expectedWorkspaceId: tenants.aliceWs as string };
  return { ...tenants, connectionId, args };
}

const mint = (t: Awaited<ReturnType<typeof alice>>["t"], connectionId: Id<"googleConnections">, role: "standard" | "agent") =>
  t.action(internal.functions.googleConnect.mintGoogleAccessTokenOutcome, { connectionId, role, forceRefresh: false });

describe("a split row and a row made before, side by side with the switch off", () => {
  test("a new row's AI never mints from the standard grant; the person's own use still does", async () => {
    const { t, connectionId } = await alice("split");
    expect(await mint(t, connectionId, "agent")).toEqual({ kind: "refused" });
    expect(await mint(t, connectionId, "standard")).toMatchObject({ kind: "minted", accessToken: "standard-access-token" });
  });

  test("a row made before keeps AI on the grant it already has", async () => {
    const { t, connectionId } = await alice(undefined);
    expect(await mint(t, connectionId, "agent")).toMatchObject({ kind: "minted", accessToken: "standard-access-token" });
  });

  test("a new row without AI access waits for it, by name, and is never told to reconnect", async () => {
    const { t, args } = await alice("split");
    expect(await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, args)).toEqual({
      ok: false,
      refused: "ai_access_needed",
      aiAccess: ["alice@gmail.example"],
    });
    const legacy = await alice(undefined);
    expect(await legacy.t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, legacy.args)).toMatchObject({ ok: true });
  });

  test("the app asks a new row's owner for AI access, and only offers it to a row made before", async () => {
    for (const [plan, expected] of [["split", "needed"], [undefined, "available"]] as const) {
      const { t, alice: owner, aliceWs } = await alice(plan);
      const rows = await asUser(t, owner).query(api.functions.googleClientsAccess.myGoogleAiAccess, { workspaceId: aliceWs });
      expect(rows.map((row) => row.aiAccess)).toEqual([expected]);
    }
  });

  test("the app never shows a new row waiting for AI access as read-only, which would offer a reconnect", async () => {
    const { t, alice: owner, aliceWs } = await alice("split");
    const rows = await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, { workspaceId: aliceWs });
    expect(rows.map((row) => row.readOnly)).toEqual([[]]);
  });

  test("sync waits for a new row's AI access rather than failing as a reconnect", async () => {
    const { t, connectionId, aliceWs } = await alice("split");
    expect(await t.query(internal.functions.googleSync.googleForwardSyncJob, { workspaceId: aliceWs, connectionId })).toEqual({
      kind: "skip",
      reason: "GOOGLE_AI_ACCESS_NEEDED",
    });
    const legacy = await alice(undefined);
    expect(await legacy.t.query(internal.functions.googleSync.googleForwardSyncJob, { workspaceId: legacy.aliceWs, connectionId: legacy.connectionId })).not.toEqual({
      kind: "skip",
      reason: "GOOGLE_AI_ACCESS_NEEDED",
    });
  });

  test("once the new row's owner allows AI access, AI reads through that grant and the calendar opens", async () => {
    const { t, connectionId, args, aliceWs } = await alice("split");
    const keyset = requireKeyset();
    const context = { workspaceId: aliceWs as string };
    await t.run(async (ctx) =>
      ctx.db.patch(connectionId, {
        agentGrant: {
          encryptedRefreshToken: await encryptSecret("agent-refresh-token", keyset, context),
          encryptedAccessToken: await encryptSecret("agent-access-token", keyset, context),
          accessTokenExpiresAt: Date.now() + HOUR,
          scopes: [...IDENTITY_SCOPES, GMAIL_SCOPES[0], CALENDAR_OWNED_SCOPE],
          grantedAt: Date.now(),
        },
      }),
    );
    expect(await mint(t, connectionId, "agent")).toMatchObject({ kind: "minted", accessToken: "agent-access-token" });
    expect(await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, args)).toMatchObject({ ok: true });
  });
});
