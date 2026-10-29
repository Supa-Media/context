/**
 * An account AI may not use until its owner allows AI access is named as
 * that (`ai_access_needed`, `aiAccessNeeded` in `lib/googleConnect/aiScopes.ts`),
 * never as a reconnect: after the switch a reconnect gives the standard
 * client a new grant AI never reads, so "reconnect" would send the person
 * round in a loop. A sign-in Google stopped honouring is still a reconnect.
 * And the census that counts, before the switch, how many live connections
 * AI could still read: numbers only.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `aiAccessNeeded` always false (every unreadable account a reconnect,
 *     as before) fails every "... waits for AI access ..." test.
 *  2. `aiAccessNeeded` ignoring `grantFor` (true whenever there is no agent
 *     grant) fails "before the switch, a standard grant without the calendar
 *     read is still a reconnect".
 *  3. The census counting a disconnected connection fails "the census
 *     counts live connections only, by AI access".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { hashToken } from "../../functions/lib/crypto";
import { CALENDAR_SCOPES, CALENDAR_WRITE_SCOPE, CHAT_READ_SCOPES, CHAT_SEND_SCOPES, GMAIL_SCOPES, GMAIL_SEND_SCOPE, IDENTITY_SCOPES } from "../../functions/lib/googleOAuth";
import { seedGoogleConnection } from "../fixtures.helpers";
import { ACCESS_A, twoConnectedTenants } from "../controlPlane/fixtures.helpers";

const AGENT_ID = "agent-client.apps.googleusercontent.example";
const ADDRESS = "alice@gmail.example";

afterEach(() => {
  vi.unstubAllEnvs();
});

function configure(active: boolean) {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "standard-client.apps.googleusercontent.example");
  vi.stubEnv("GOOGLE_AGENT_OAUTH_CLIENT_ID", AGENT_ID);
  vi.stubEnv("GOOGLE_AGENT_CLIENT_ACTIVE", active ? "true" : "false");
}

type Patch = { products?: Array<"gmail" | "calendar" | "chat">; scopes?: string[]; agentScopes?: string[] | null; health?: "reconnect_required"; disconnected?: boolean };

/** Alice's personal workspace with one Google connection shaped by `patch`, and a grant that reaches private notes. */
async function alice(patch: Patch) {
  const tenants = await twoConnectedTenants();
  const connectionId = await seedGoogleConnection(tenants.t, { workspaceId: tenants.aliceWs, boundBy: tenants.alice, address: ADDRESS });
  await tenants.t.run(async (ctx) => {
    await ctx.db.patch(connectionId, {
      products: patch.products ?? ["gmail", "calendar", "chat"],
      scopes: patch.scopes ?? [...IDENTITY_SCOPES, ...GMAIL_SCOPES, GMAIL_SEND_SCOPE, ...CALENDAR_SCOPES, CALENDAR_WRITE_SCOPE, ...CHAT_READ_SCOPES, ...CHAT_SEND_SCOPES],
      ...(patch.health ? { health: patch.health } : {}),
      ...(patch.disconnected ? { disconnectedAt: Date.now() } : {}),
      ...(patch.agentScopes ? { agentGrant: { encryptedRefreshToken: "sealed-agent-refresh-not-real", scopes: patch.agentScopes, grantedAt: Date.now() } } : {}),
    });
    await ctx.db.patch(tenants.grantA, { scopes: ["context:read", "context:write", "context:private"] });
  });
  const args = { hashedAccessToken: await hashToken(ACCESS_A), expectedWorkspaceId: tenants.aliceWs as string };
  return { ...tenants, connectionId, args };
}

describe("an account that waits for AI access is named for it, not for a reconnect", () => {
  test("after the switch, a calendar with no agent grant waits for AI access", async () => {
    configure(true);
    const { t, args } = await alice({});
    expect(await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, args)).toEqual({
      ok: false,
      refused: "ai_access_needed",
      aiAccess: [ADDRESS],
    });
  });

  test("an agent grant with the calendar box unticked waits for AI access again, before the switch too", async () => {
    configure(false);
    const { t, args } = await alice({ products: ["gmail", "calendar"], agentScopes: [...GMAIL_SCOPES] });
    expect(await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, args)).toEqual({
      ok: false,
      refused: "ai_access_needed",
      aiAccess: [ADDRESS],
    });
  });

  test("a sign-in Google stopped honouring is still a reconnect, whatever AI access says", async () => {
    configure(true);
    const { t, args } = await alice({ health: "reconnect_required" });
    expect(await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, args)).toEqual({
      ok: false,
      refused: "reconnect_required",
      reconnect: [ADDRESS],
    });
  });

  test("before the switch, a standard grant without the calendar read is still a reconnect", async () => {
    configure(false);
    const { t, args } = await alice({ products: ["calendar"], scopes: [...IDENTITY_SCOPES] });
    expect(await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, args)).toEqual({
      ok: false,
      refused: "reconnect_required",
      reconnect: [ADDRESS],
    });
  });

  test("after the switch, Gmail with no agent grant waits for AI access, for reading and for sending", async () => {
    configure(true);
    const { t, args } = await alice({});
    expect(await t.mutation(internal.functions.personMail.claimPersonMailRead, { ...args, address: null })).toEqual({
      ok: false,
      refused: "ai_access_needed",
      aiAccess: [ADDRESS],
    });
    const recipientHashes = [await hashToken("friend@example.invalid")];
    const send = await t.mutation(internal.functions.personEmail.claimPersonEmail, { ...args, recipientHashes, from: null, spend: false });
    expect(send).toEqual({ ok: false, refused: "ai_access_needed" });
  });

  test("after the switch, Chat with no agent grant waits for AI access", async () => {
    configure(true);
    const { t, args } = await alice({});
    expect(await t.mutation(internal.functions.googleChatSend.claimChatSend, { ...args, to: "person", spend: false })).toEqual({
      ok: false,
      refused: "ai_access_needed",
    });
  });

  test("before the switch, with no agent grant, nothing waits: AI reads through the standard grant as today", async () => {
    configure(false);
    const { t, args } = await alice({});
    expect(await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, args)).toMatchObject({ ok: true, reconnect: [] });
    const read = await t.mutation(internal.functions.personMail.claimPersonMailRead, { ...args, address: null });
    expect(read).toMatchObject({ ok: true });
    expect(read).not.toHaveProperty("aiAccess");
  });

  test("a connection that has never connected Gmail is no sender, not one waiting for AI access", async () => {
    configure(true);
    const { t, args } = await alice({ products: ["calendar"] });
    const recipientHashes = [await hashToken("friend@example.invalid")];
    expect(await t.mutation(internal.functions.personEmail.claimPersonEmail, { ...args, recipientHashes, from: null, spend: false })).toEqual({
      ok: false,
      refused: "no_sender",
    });
  });
});

describe("the AI access census", () => {
  test("the census counts live connections only, by AI access, and holds nothing but numbers", async () => {
    configure(false);
    const { t, alice: aliceId, aliceWs, bob, bobWs } = await twoConnectedTenants();
    const seed = async (workspaceId: Id<"workspaces">, boundBy: Id<"users">, address: string, patch: Patch) => {
      const id = await seedGoogleConnection(t, { workspaceId, boundBy, address });
      await t.run((ctx) =>
        ctx.db.patch(id, {
          products: patch.products ?? ["gmail"],
          ...(patch.disconnected ? { disconnectedAt: Date.now() } : {}),
          ...(patch.agentScopes ? { agentGrant: { encryptedRefreshToken: "sealed-not-real", scopes: patch.agentScopes, grantedAt: Date.now() } } : {}),
        }),
      );
    };
    await seed(aliceWs, aliceId, "covering@example.invalid", { agentScopes: [...GMAIL_SCOPES] });
    await seed(aliceWs, aliceId, "partial@example.invalid", { products: ["gmail", "calendar"], agentScopes: [...GMAIL_SCOPES] });
    await seed(bobWs, bob, "missing@example.invalid", {});
    await seed(bobWs, bob, "gone@example.invalid", { disconnected: true, agentScopes: [...GMAIL_SCOPES] });
    vi.stubEnv("GOOGLE_CUTOVER_CANARY_WORKSPACES", aliceWs as string);

    const census = await t.action(internal.functions.googleClientsAccess.aiAccessCensus, {});
    expect(census).toEqual({ live: 3, covering: 1, partial: 1, missing: 1, canary: 2 });
    expect(JSON.stringify(census)).not.toMatch(/@|example|[a-z0-9]{20,}/);
  });
});
