import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { createUser, createWorkspace, gatewayPost, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * "DONE" ON TEX'S TAKE-OVER SCREEN CARRIES THE TASK ON (Dev2, 2026-11-12: "it
 * should notify tex so it continues on").
 *
 * The gateway marks a browser handed back for a person with a live grant
 * (`/gateway/browser-handback`), and the texting Worker, behind its secret,
 * asks whether a browser it watches was handed back since it texted the link
 * (`/agent-texts/handed-back`). Times only, by a hash nobody else can make.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `markHandedBack` with no grant check                                  1
 *   `handedBackSince` not filtering by `since`                            1
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const CLIENT = "mcp_client_browser_handbacks";
const A = "a".repeat(64);
const B = "b".repeat(64);

async function grant(t: TestConvex, workspaceId: Id<"workspaces">, userId: Id<"users">) {
  const accessToken = `cat_browser_handback_${Math.random().toString(16).slice(2)}${"0".repeat(16)}`;
  const hashedAccessToken = await hashToken(accessToken);
  await t.run(async (ctx) => {
    await ctx.db.insert("oauthClients", {
      clientId: CLIENT,
      clientName: "Hand-back test client",
      redirectUris: [],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
      grantTypes: [],
      responseTypes: [],
      createdAt: Date.now(),
    });
    await ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId: CLIENT,
      scopes: ["context:read", "context:write", "context:private"],
      hashedAccessToken,
      hashedRefreshToken: `refresh_${hashedAccessToken}`,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      status: "active",
      createdAt: Date.now(),
    });
  });
  return accessToken;
}

async function handBack(t: TestConvex, body: Record<string, unknown>) {
  const response = await gatewayPost(t, "/gateway/browser-handback", body);
  expect(response.status).toBe(200);
  return (await response.json()) as { doneAt: number | null };
}

async function look(t: TestConvex, body: Record<string, unknown>, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch("/agent-texts/handed-back", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("browser hand-back", () => {
  test("a person's Done is heard by the Worker watching that browser, and only after the link went", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@example.com");
    const workspaceId = await createWorkspace(t, userId, "ada", { kind: "personal" });
    const accessToken = await grant(t, workspaceId, userId);
    const since = Date.now() - 1_000;
    expect((await look(t, { browsers: [A], since })).body).toEqual({ status: "waiting" });
    const { doneAt } = await handBack(t, { accessToken, browser: A });
    expect(typeof doneAt).toBe("number");
    expect((await look(t, { browsers: [A], since })).body).toEqual({ status: "done", doneAt });
    // Another browser's Done is not this one's, and a Done from before the link is not this one.
    expect((await look(t, { browsers: [B], since })).body).toEqual({ status: "waiting" });
    expect((await look(t, { browsers: [A], since: (doneAt as number) + 1 })).body).toEqual({ status: "waiting" });
  });

  test("no grant, no mark; a malformed browser is refused; the Worker's route needs its secret", async () => {
    const t = setupTest();
    expect(await handBack(t, { accessToken: "cat_not_a_real_token_0000000000000000", browser: A })).toEqual({ doneAt: null });
    expect((await look(t, { browsers: [A], since: 0 })).body).toEqual({ status: "waiting" });
    const userId = await createUser(t, "bob@example.com");
    const workspaceId = await createWorkspace(t, userId, "bob", { kind: "personal" });
    const accessToken = await grant(t, workspaceId, userId);
    expect(await handBack(t, { accessToken, browser: "not-a-hash" })).toEqual({ doneAt: null });
    expect((await look(t, { browsers: ["x"], since: 0 })).status).toBe(400);
    expect((await look(t, { browsers: [A], since: 0 }, null)).status).not.toBe(200);
  });
});
