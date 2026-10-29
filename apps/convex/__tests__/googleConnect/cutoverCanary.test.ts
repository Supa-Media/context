/**
 * The cutover canary (`cutoverCanary` / `googleEnvFor` in
 * `functions/lib/googleConnect/clients.ts`): the workspaces the deployment
 * names in `GOOGLE_CUTOVER_CANARY_WORKSPACES` run as though
 * `GOOGLE_AGENT_CLIENT_ACTIVE=true` and `GOOGLE_CALENDAR_SCOPE=owned`, and
 * every other workspace runs on the global values. It exists so the final
 * scopes are filmed and proven on a synthetic account while Google's Data
 * Access list does not carry them yet, without asking everyone for them.
 *
 * Each test runs a canary workspace beside one that is not named, in the same
 * deployment, so a canary that leaked to the neighbour fails here.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `googleEnvFor` ignoring the list (always the global env) fails every
 *     "the canary workspace ..." test.
 *  2. `googleEnvFor` applying the canary to every workspace fails every
 *     "... its neighbour ..." assertion.
 *  3. Dropping the three-workspace limit fails "a list longer than three
 *     names nobody".
 *  4. `mintAccessToken` reading `grantFor` without the workspace's env fails
 *     "the canary workspace's AI mints only from the agent grant".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import {
  CALENDAR_OWNED_READ_SCOPE,
  CALENDAR_OWNED_SCOPE,
  CALENDAR_SCOPES,
  CALENDAR_WRITE_SCOPE,
  GMAIL_SCOPES,
  IDENTITY_SCOPES,
} from "../../functions/lib/googleOAuth";
import { cutoverCanary, googleEnvFor } from "../../functions/lib/googleConnect/clients";
import { asUser, createUser, createWorkspace, seedGoogleConnection, setupTest } from "../fixtures.helpers";
import { REDIRECT, enableAllGoogleConnect } from "./fixtures.helpers";

const AGENT_ID = "agent-client.apps.googleusercontent.example";
const CALLBACK = "https://app.context.invalid/connect/google";
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("which workspaces the canary names", () => {
  const env = (value: string) => ({ GOOGLE_CUTOVER_CANARY_WORKSPACES: value });

  test("only a workspace the deployment lists, by exact id", () => {
    expect(cutoverCanary("ws_canary", env("ws_canary"))).toBe(true);
    expect(cutoverCanary("ws_canary", env(" ws_other , ws_canary "))).toBe(true);
    expect(cutoverCanary("ws_other", env("ws_canary"))).toBe(false);
    expect(cutoverCanary("ws_canar", env("ws_canary"))).toBe(false);
    expect(cutoverCanary("ws_canary_2", env("ws_canary"))).toBe(false);
  });

  test("nothing listed, a brake value, or no workspace names nobody", () => {
    expect(cutoverCanary("ws_canary", {})).toBe(false);
    expect(cutoverCanary("ws_canary", env(""))).toBe(false);
    expect(cutoverCanary("ws_canary", env("none"))).toBe(false);
    expect(cutoverCanary(undefined, env("ws_canary"))).toBe(false);
    expect(cutoverCanary("", env(","))).toBe(false);
  });

  test("a list longer than three names nobody, so it cannot become the rollout", () => {
    expect(cutoverCanary("ws_a", env("ws_a,ws_b,ws_c"))).toBe(true);
    expect(cutoverCanary("ws_a", env("ws_a,ws_b,ws_c,ws_d"))).toBe(false);
  });

  test("a canary workspace reads both cutover settings on; any other reads the deployment's own, untouched", () => {
    const deployment = { GOOGLE_CUTOVER_CANARY_WORKSPACES: "ws_canary", GOOGLE_AGENT_CLIENT_ACTIVE: "false", GOOGLE_CALENDAR_SCOPE: "broad" };
    expect(googleEnvFor("ws_canary", deployment)).toMatchObject({ GOOGLE_AGENT_CLIENT_ACTIVE: "true", GOOGLE_CALENDAR_SCOPE: "owned" });
    expect(googleEnvFor("ws_other", deployment)).toBe(deployment);
    expect(deployment).toMatchObject({ GOOGLE_AGENT_CLIENT_ACTIVE: "false", GOOGLE_CALENDAR_SCOPE: "broad" });
  });
});

/** Two personal workspaces in one deployment, each with a Calendar connection holding the broad pair and no agent grant. Only the first is the canary. */
async function canaryAndNeighbour() {
  const t = setupTest();
  const canaryOwner = await createUser(t, "synthetic@example.invalid");
  const canary = await createWorkspace(t, canaryOwner, "synthetic");
  const neighbourOwner = await createUser(t, "neighbour@example.invalid");
  const neighbour = await createWorkspace(t, neighbourOwner, "neighbour");
  const keyset = requireKeyset();
  const connections: Record<"canary" | "neighbour", Id<"googleConnections">> = {} as never;
  for (const [name, workspaceId, owner] of [["canary", canary, canaryOwner], ["neighbour", neighbour, neighbourOwner]] as const) {
    const connectionId = await seedGoogleConnection(t, { workspaceId, boundBy: owner, address: `${name}@gmail.example` });
    const standardAccess = await encryptSecret("standard-access-token", keyset, { workspaceId: workspaceId as string });
    await t.run((ctx) =>
      ctx.db.patch(connectionId, {
        products: ["gmail", "calendar"],
        scopes: [...IDENTITY_SCOPES, ...GMAIL_SCOPES, ...CALENDAR_SCOPES, CALENDAR_WRITE_SCOPE],
        encryptedAccessToken: standardAccess,
        accessTokenExpiresAt: Date.now() + HOUR,
      }),
    );
    connections[name] = connectionId;
  }
  // The deployment: agent client configured, both global settings off, the canary naming one workspace.
  enableAllGoogleConnect();
  vi.stubEnv("APP_ORIGIN", "https://app.context.invalid");
  vi.stubEnv("GOOGLE_AGENT_OAUTH_CLIENT_ID", AGENT_ID);
  vi.stubEnv("GOOGLE_AGENT_CLIENT_ACTIVE", "false");
  vi.stubEnv("GOOGLE_CALENDAR_SCOPE", "broad");
  vi.stubEnv("GOOGLE_CUTOVER_CANARY_WORKSPACES", canary as string);
  return { t, canary, canaryOwner, neighbour, neighbourOwner, connections };
}

async function standardConsent(t: ReturnType<typeof setupTest>, owner: Id<"users">, workspaceId: Id<"workspaces">) {
  const result = await asUser(t, owner).action(api.functions.googleConnect.startGoogleConnect, {
    workspaceId,
    redirectUri: REDIRECT,
    syncServices: { gmail: true, calendar: true, chat: false },
  });
  return new Set(new URL(result.authorizeUrl).searchParams.get("scope")?.split(" ") ?? []);
}

describe("the canary runs the final scopes on its workspace alone", () => {
  test("the canary workspace's standard consent is identity plus the owned calendar read; its neighbour's is today's", async () => {
    const { t, canary, canaryOwner, neighbour, neighbourOwner } = await canaryAndNeighbour();
    expect(await standardConsent(t, canaryOwner, canary)).toEqual(new Set([...IDENTITY_SCOPES, CALENDAR_OWNED_READ_SCOPE]));
    const neighbours = await standardConsent(t, neighbourOwner, neighbour);
    expect(neighbours).toContain(GMAIL_SCOPES[0]);
    expect(neighbours).toContain(CALENDAR_WRITE_SCOPE);
    expect(neighbours).not.toContain(CALENDAR_OWNED_SCOPE);
  });

  test("the canary workspace's AI consent asks the agent client for the owned calendar pair; its neighbour's for the broad one", async () => {
    const { t, canary, canaryOwner, neighbour, neighbourOwner, connections } = await canaryAndNeighbour();
    const agentConsent = async (owner: Id<"users">, workspaceId: Id<"workspaces">, connectionId: Id<"googleConnections">) => {
      const started = await asUser(t, owner).action(api.functions.googleClients.startGoogleAgentConnect, { workspaceId, connectionId, redirectUri: CALLBACK });
      const url = new URL(started.authorizeUrl);
      expect(url.searchParams.get("client_id")).toBe(AGENT_ID);
      return url.searchParams.get("scope")?.split(" ") ?? [];
    };
    const canaryScopes = await agentConsent(canaryOwner, canary, connections.canary);
    expect(canaryScopes).toContain(CALENDAR_OWNED_SCOPE);
    expect(canaryScopes).not.toContain(CALENDAR_WRITE_SCOPE);
    const neighbourScopes = await agentConsent(neighbourOwner, neighbour, connections.neighbour);
    expect(neighbourScopes).toContain(CALENDAR_WRITE_SCOPE);
    expect(neighbourScopes).not.toContain(CALENDAR_OWNED_SCOPE);
  });

  test("the canary workspace's AI mints only from the agent grant: without one it is refused; its neighbour reads as today", async () => {
    const { t, connections } = await canaryAndNeighbour();
    const mint = (connectionId: Id<"googleConnections">) =>
      t.action(internal.functions.googleConnect.mintGoogleAccessTokenOutcome, { connectionId, role: "agent", forceRefresh: false });
    expect(await mint(connections.canary)).toEqual({ kind: "refused" });
    expect(await mint(connections.neighbour)).toMatchObject({ kind: "minted", accessToken: "standard-access-token" });
    // The person's own use of the canary account is unchanged.
    expect(
      await t.action(internal.functions.googleConnect.mintGoogleAccessTokenOutcome, { connectionId: connections.canary, role: "standard", forceRefresh: false }),
    ).toMatchObject({ kind: "minted", accessToken: "standard-access-token" });
  });

  test("with an agent grant the canary workspace's AI mints from it", async () => {
    const { t, canary, connections } = await canaryAndNeighbour();
    const keyset = requireKeyset();
    const context = { workspaceId: canary as string };
    const agentGrant = {
      encryptedRefreshToken: await encryptSecret("agent-refresh-token", keyset, context),
      encryptedAccessToken: await encryptSecret("agent-access-token", keyset, context),
      accessTokenExpiresAt: Date.now() + HOUR,
      scopes: [...GMAIL_SCOPES, CALENDAR_OWNED_SCOPE],
      grantedAt: Date.now(),
    };
    await t.run((ctx) => ctx.db.patch(connections.canary, { agentGrant }));
    expect(
      await t.action(internal.functions.googleConnect.mintGoogleAccessTokenOutcome, { connectionId: connections.canary, role: "agent", forceRefresh: false }),
    ).toMatchObject({ kind: "minted", accessToken: "agent-access-token" });
  });

  test("the app tells the canary account AI access is needed; its neighbour that it is available", async () => {
    const { t, canary, canaryOwner, neighbour, neighbourOwner } = await canaryAndNeighbour();
    const access = async (owner: Id<"users">, workspaceId: Id<"workspaces">) =>
      (await asUser(t, owner).query(api.functions.googleClientsAccess.myGoogleAiAccess, { workspaceId }))[0]?.aiAccess;
    expect(await access(canaryOwner, canary)).toBe("needed");
    expect(await access(neighbourOwner, neighbour)).toBe("available");
  });

  test("a canary owner cannot reach the neighbour's connection, and the canary is not a caller's to claim", async () => {
    const { t, canaryOwner, neighbour, connections } = await canaryAndNeighbour();
    await expect(
      asUser(t, canaryOwner).action(api.functions.googleClients.startGoogleAgentConnect, {
        workspaceId: neighbour,
        connectionId: connections.neighbour,
        redirectUri: CALLBACK,
      }),
    ).rejects.toThrow();
    expect(await asUser(t, canaryOwner).query(api.functions.googleClientsAccess.myGoogleAiAccess, { workspaceId: neighbour })).toEqual([]);
  });
});
