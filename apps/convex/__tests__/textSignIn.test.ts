import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  createUser,
  createWorkspace,
  drainScheduled,
  seedStorageBinding,
  setupTest,
  withoutFixtureSessions,
  type TestConvex,
} from "./fixtures.helpers";
import { SIGN_IN_CODE_TTL_MS, SIGN_IN_LINK_TTL_MS } from "../functions/textSignIn";

/**
 * THE SIGN-IN LINK TEX TEXTS ONCE A TEXTED SETUP'S NOTES ARE READY
 * (Dev2, 2026-10-18: "since it's coming from that number already, then it's
 * pre-authenticated").
 *
 * What must hold, since a link that signs in is a credential:
 *
 *  - none is issued until the workspace's storage answers and its folders are
 *    laid out, and none for a phone nobody links;
 *  - opening it signs in the account holding the phone it was texted to, and
 *    nobody else, through the real `phone-verify` sign-in;
 *  - it opens once, within a day, and the code an opening mints is good once,
 *    for five minutes, for that phone only;
 *  - the route sits behind the texting Worker's secret.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `readyLink` ignoring the binding's status                             1
 *   `readyLink` ignoring the layout row                                   1
 *   `openByHash` not refusing a link opened before                        1
 *   `openByHash` ignoring `expiresAt`                                     1
 *   `consumeCode` not checking the phone                                  1
 *   `consumeCode` keeping the row after a sign-in                         1
 *   `consumeCode` ignoring `codeExpiresAt`                                1
 */

const PHONE = "+15555550100";
const OTHER_PHONE = "+15555550142";
const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";

beforeEach(async () => {
  vi.stubEnv("SITE_URL", "https://context.test");
  vi.stubEnv("CONVEX_SITE_URL", "https://context.test");
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("JWT_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    throw new Error(`network access attempted: ${String(input)}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function agentPost(t: TestConvex, body: unknown, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch("/agent-texts/ready", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

/** Someone set up by text: a held, linked phone and a personal workspace with a bucket on the way. */
async function texter(t: TestConvex, phone = PHONE, slug = "ada") {
  const userId = await createUser(t, `${slug}@home.example`);
  await t.run((ctx) => ctx.db.patch(userId, { phone, phoneVerificationTime: 1 }));
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  await t.run((ctx) => ctx.db.insert("phoneLinks", { userId, phone, linkedAt: 1 }));
  await t.run((ctx) => ctx.db.insert("textSetups", { stage: "layout", userId, workspaceId, at: 1 }));
  return { userId, workspaceId };
}

async function ready(t: TestConvex, who: { userId: Id<"users">; workspaceId: Id<"workspaces"> }) {
  await seedStorageBinding(t, { workspaceId: who.workspaceId, boundBy: who.userId, status: "connected" });
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("textSetups").collect()) await ctx.db.delete(row._id);
  });
}

const tokenOf = (url: unknown) => /\/signin\/([0-9a-f]{64})$/.exec(String(url))?.[1] ?? null;

async function signIn(t: TestConvex, phone: string, code: string) {
  const result = await t.action(api.auth.signIn, { provider: "phone-verify", params: { phone, code } });
  await drainScheduled(t);
  return result;
}

async function sessionUsers(t: TestConvex) {
  return await t.run(async (ctx) =>
    withoutFixtureSessions(await ctx.db.query("authSessions").collect()).map((row) => row.userId),
  );
}

describe("issuing the link", () => {
  test("only the texting Worker may ask", async () => {
    const t = setupTest();
    expect((await agentPost(t, { phone: PHONE }, null)).status).toBe(401);
    expect((await agentPost(t, { phone: PHONE }, "wrong-secret")).status).toBe(401);
  });

  test("waits for the storage to answer and the folders to be laid out, then names the Google card", async () => {
    const t = setupTest();
    const who = await texter(t);
    expect((await agentPost(t, { phone: PHONE })).body).toEqual({ status: "waiting" });

    await seedStorageBinding(t, { workspaceId: who.workspaceId, boundBy: who.userId, status: "connected" });
    // Answering, but its folders not laid out yet.
    expect((await agentPost(t, { phone: PHONE })).body).toEqual({ status: "waiting" });

    await ready(t, who);
    const answer = (await agentPost(t, { phone: PHONE })).body;
    expect(answer.status).toBe("ready");
    expect(tokenOf(answer.url)).not.toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("textSignInLinks").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: PHONE, userId: who.userId, next: "/console/@ada?settings=integrations" });
    // Only the hash is kept.
    expect(JSON.stringify(rows)).not.toContain(tokenOf(answer.url)!);
  });

  test("an unverified binding is still waiting", async () => {
    const t = setupTest();
    const who = await texter(t);
    await seedStorageBinding(t, { workspaceId: who.workspaceId, boundBy: who.userId, status: "unverified" });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("textSetups").collect()) await ctx.db.delete(row._id);
    });
    expect((await agentPost(t, { phone: PHONE })).body).toEqual({ status: "waiting" });
  });

  test("a phone nobody links is told to stop asking, and gets no link", async () => {
    const t = setupTest();
    expect((await agentPost(t, { phone: PHONE })).body).toEqual({ status: "gone" });
    expect(await t.run((ctx) => ctx.db.query("textSignInLinks").collect())).toEqual([]);
  });
});

describe("opening the link", () => {
  async function issued(t: TestConvex) {
    const who = await texter(t);
    await ready(t, who);
    const token = tokenOf((await agentPost(t, { phone: PHONE })).body.url)!;
    return { ...who, token };
  }

  test("signs in the account holding the phone it was texted to, and goes to the Google card", async () => {
    const t = setupTest();
    const { userId, token } = await issued(t);
    const opened = await t.action(api.functions.textSignIn.open, { token });
    expect(opened).toMatchObject({ status: "open", phone: PHONE, next: "/console/@ada?settings=integrations" });
    if (opened.status !== "open") throw new Error("not opened");
    expect(opened.code).toMatch(/^\d{10}$/);
    expect((await signIn(t, PHONE, opened.code)).tokens).toBeTruthy();
    expect(await sessionUsers(t)).toEqual([userId]);
  });

  test("opens once: a second opening is spent, and its code signs in once", async () => {
    const t = setupTest();
    const { token } = await issued(t);
    const opened = await t.action(api.functions.textSignIn.open, { token });
    if (opened.status !== "open") throw new Error("not opened");
    expect(await t.action(api.functions.textSignIn.open, { token })).toEqual({
      status: "spent",
      next: "/console/@ada?settings=integrations",
    });
    expect((await signIn(t, PHONE, opened.code)).tokens).toBeTruthy();
    expect((await signIn(t, PHONE, opened.code)).tokens).toBeNull();
  });

  test("the code signs in no other phone", async () => {
    const t = setupTest();
    const { token } = await issued(t);
    await texter(t, OTHER_PHONE, "bea");
    const opened = await t.action(api.functions.textSignIn.open, { token });
    if (opened.status !== "open") throw new Error("not opened");
    expect((await signIn(t, OTHER_PHONE, opened.code)).tokens).toBeNull();
    expect(await sessionUsers(t)).toEqual([]);
  });

  test("a link a day old is spent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const { token } = await issued(t);
    vi.setSystemTime(Date.now() + SIGN_IN_LINK_TTL_MS + 1);
    expect((await t.action(api.functions.textSignIn.open, { token })).status).toBe("spent");
  });

  test("a code five minutes old signs in nobody", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const { token } = await issued(t);
    const opened = await t.action(api.functions.textSignIn.open, { token });
    if (opened.status !== "open") throw new Error("not opened");
    vi.setSystemTime(Date.now() + SIGN_IN_CODE_TTL_MS + 1);
    expect((await signIn(t, PHONE, opened.code)).tokens).toBeNull();
  });

  test("a token never issued, or of the wrong shape, is spent with nowhere to go", async () => {
    const t = setupTest();
    expect(await t.action(api.functions.textSignIn.open, { token: "a".repeat(64) })).toEqual({ status: "spent" });
    expect(await t.action(api.functions.textSignIn.open, { token: "not-a-token" })).toEqual({ status: "spent" });
  });

  test("a wrong code is refused and leaves the link's code standing", async () => {
    const t = setupTest();
    const { token } = await issued(t);
    const opened = await t.action(api.functions.textSignIn.open, { token });
    if (opened.status !== "open") throw new Error("not opened");
    const wrong = opened.code === "0000000000" ? "0000000001" : "0000000000";
    expect((await signIn(t, PHONE, wrong)).tokens).toBeNull();
    expect((await signIn(t, PHONE, opened.code)).tokens).toBeTruthy();
  });

  test("expired rows are swept", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    await issued(t);
    vi.setSystemTime(Date.now() + SIGN_IN_LINK_TTL_MS + SIGN_IN_CODE_TTL_MS + 1);
    await t.mutation(internal.functions.textSignIn.purgeExpired, {});
    expect(await t.run((ctx) => ctx.db.query("textSignInLinks").collect())).toEqual([]);
  });
});
