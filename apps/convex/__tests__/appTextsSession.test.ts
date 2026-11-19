/**
 * THE CONTEXT APP'S CHAT WITH TEX ASKS FOR ITS SESSION BY USER ID (`/agent-texts/app-session`,
 * `functions/lib/gatewayRoutes/agentTexts.ts`; decision docs/decisions/texting-assistant/app-chat.md).
 *
 * The same grant a phone's text gets, for the user's own personal workspace, with the phone path's own checks: only
 * with the worker secret, never for an id that is not a user, never for someone with no personal workspace, never
 * while texting is paused, and never wider than that one workspace.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-11-19).
 *
 *   the route registered without `agentWorkerRoute`             1 failed ("refuses without the worker secret")
 *   `applyAppTextsGrant` minting before `personalWorkspaceOf`   1 failed ("refuses someone with no personal workspace")
 *   `via: "app"` dropped from the app's mint                    1 failed ("marks the audit row and starts no check-ins")
 */

import { describe, expect, test } from "vitest";
import { addMember, createUser, createWorkspace, setupTest } from "./fixtures.helpers";

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";

type T = ReturnType<typeof setupTest>;

async function appSession(t: T, body: unknown, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch("/agent-texts/app-session", { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
}

describe("/agent-texts/app-session", () => {
  test("mints a texts grant on the user's own personal workspace, and no other", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const home = await createWorkspace(t, ada, "ada-home", { kind: "personal" });
    const bo = await createUser(t, "bo@example.invalid");
    const studio = await createWorkspace(t, bo, "bo-studio", { kind: "shared" });
    await addMember(t, studio, ada, "editor");

    const answer = await appSession(t, { userId: ada });
    expect(answer.status).toBe(200);
    expect(answer.body?.status).toBe("linked");
    expect(typeof answer.body?.accessToken).toBe("string");
    const grants = await t.run((ctx) => ctx.db.query("oauthGrants").collect());
    const texts = grants.filter((grant) => grant.clientId === "context_texts" && grant.userId === ada);
    expect(texts.map((grant) => grant.workspaceId)).toEqual([home]);
  });

  test("marks the audit row and starts no check-ins", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    await createWorkspace(t, ada, "ada-home", { kind: "personal" });
    expect((await appSession(t, { userId: ada })).body?.status).toBe("linked");
    const audits = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    const opened = audits.filter((row) => row.action === "texts.session.opened");
    expect(opened.length).toBe(1);
    expect((opened[0]!.details as Record<string, unknown>).via).toBe("app");
    const beats = await t.run((ctx) => ctx.db.query("texHeartbeats").collect());
    expect(beats).toEqual([]);
  });

  test("refuses without the worker secret", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    await createWorkspace(t, ada, "ada-home", { kind: "personal" });
    expect((await appSession(t, { userId: ada }, null)).status).toBe(401);
    expect((await appSession(t, { userId: ada }, "not-the-secret")).status).toBe(401);
    expect(await t.run((ctx) => ctx.db.query("oauthGrants").collect())).toEqual([]);
  });

  test("refuses an id that is not a user's, and someone with no personal workspace", async () => {
    const t = setupTest();
    for (const userId of ["", "NOT-AN-ID", "a".repeat(65), 42]) {
      const answer = await appSession(t, { userId });
      expect([400, 200]).toContain(answer.status);
      if (answer.status === 200) expect(answer.body?.status).toBe("unlinked");
    }
    const lone = await createUser(t, "lone@example.invalid");
    expect((await appSession(t, { userId: lone })).body?.status).toBe("unlinked");
    expect(await t.run((ctx) => ctx.db.query("oauthGrants").collect())).toEqual([]);
  });
});
