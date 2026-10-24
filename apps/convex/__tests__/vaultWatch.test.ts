import { describe, expect, test } from "vitest";
import { createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * TEX HEARS THAT A LOGIN WAS SAVED (Dev2, 2026-10-24: "after adding the email
 * and password Tex should know that i'm done adding").
 *
 * `POST /agent-texts/vault-saved` tells the texting Worker, behind its secret,
 * whether the phone's person used a save link at or after `since`: times
 * only, never which entry. Someone else's save is never theirs, and a link
 * nobody can use any more ends the look.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `savedSince` not filtering by `since`                                1
 *   `savedSince` treating an expired link as still waiting               1
 *   the index queried without `userId`                                   1
 */

const PHONE = "+15555550100";
const OTHER = "+15555550101";
const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";

async function linkedPhone(t: TestConvex, phone: string, slug: string) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { phone, phoneVerificationTime: 1 }));
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  await t.run((ctx) => ctx.db.insert("phoneLinks", { userId, phone, linkedAt: 1 }));
  return { userId, workspaceId };
}

async function ask(t: TestConvex, body: Record<string, unknown>, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch("/agent-texts/vault-saved", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("POST /agent-texts/vault-saved", () => {
  test("waits while the link is live, then says when it was used", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linkedPhone(t, PHONE, "ada");
    const since = Date.now() - 60_000;
    const rowId = await t.run((ctx) =>
      ctx.db.insert("vaultRequests", { hashedToken: "h1", workspaceId, userId, kind: "add", expiresAt: Date.now() + 30 * 60_000 }),
    );
    expect((await ask(t, { phone: PHONE, since })).body).toEqual({ status: "waiting" });
    const usedAt = Date.now();
    await t.run((ctx) => ctx.db.patch(rowId, { usedAt }));
    expect((await ask(t, { phone: PHONE, since })).body).toEqual({ status: "saved", savedAt: usedAt });
    // A save from before the look began is not this one.
    expect((await ask(t, { phone: PHONE, since: usedAt + 1 })).body).toEqual({ status: "gone" });
  });

  test("someone else's save is never theirs, and an expired link ends the look", async () => {
    const t = setupTest();
    const ada = await linkedPhone(t, PHONE, "ada");
    const bob = await linkedPhone(t, OTHER, "bob");
    const since = Date.now() - 60_000;
    await t.run((ctx) =>
      ctx.db.insert("vaultRequests", { hashedToken: "h2", workspaceId: bob.workspaceId, userId: bob.userId, kind: "add", expiresAt: Date.now() + 60_000, usedAt: Date.now() }),
    );
    await t.run((ctx) =>
      ctx.db.insert("vaultRequests", { hashedToken: "h3", workspaceId: ada.workspaceId, userId: ada.userId, kind: "add", expiresAt: Date.now() - 1 }),
    );
    expect((await ask(t, { phone: PHONE, since })).body).toEqual({ status: "gone" });
    expect((await ask(t, { phone: OTHER, since })).body).toMatchObject({ status: "saved" });
  });

  test("a view link is not a save", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linkedPhone(t, PHONE, "ada");
    await t.run((ctx) =>
      ctx.db.insert("vaultRequests", { hashedToken: "h4", workspaceId, userId, kind: "view", entryId: "e1", expiresAt: Date.now() + 60_000, usedAt: Date.now() }),
    );
    expect((await ask(t, { phone: PHONE, since: 0 })).body).toEqual({ status: "gone" });
  });

  test("a phone nobody links is gone, a bad body is refused, and the route sits behind the Worker's secret", async () => {
    const t = setupTest();
    expect((await ask(t, { phone: PHONE, since: 0 })).body).toEqual({ status: "gone" });
    expect((await ask(t, { phone: PHONE })).status).toBe(400);
    expect((await ask(t, { phone: PHONE, since: 0 }, null)).status).toBe(401);
    expect((await ask(t, { phone: PHONE, since: 0 }, "wrong-secret")).status).toBe(401);
  });
});
