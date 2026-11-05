/**
 * Run grants: the short-lived token a Tex job's part presents on a paired machine. It acts as the job's own texting
 * grant, under its own client id, and every check on the parent applies on every request. Every value here is fake.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { resolveLiveGrant } from "../functions/lib/controlPlane/liveGrants";
import { TEX_MACHINE_RUN_CLIENT_ID, TEX_MACHINE_RUN_MAX_MS } from "../functions/lib/texMachineRules";
import {
  type TestConvex,
  createUser,
  createWorkspace,
  gatewayPost,
  seedGrant,
  setupTest,
} from "./fixtures.helpers";

const PARENT = `cat_${"p".repeat(40)}`;
const OTHER_PARENT = `cat_${"o".repeat(40)}`;
const RUN_ID = `run_${"a".repeat(24)}`;
const OTHER_RUN_ID = `run_${"b".repeat(24)}`;
const MINUTE = 60 * 1000;
const FIFTEEN_MINUTES = 15 * MINUTE;
const T0 = Date.UTC(2030, 0, 1);

afterEach(() => {
  vi.useRealTimers();
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

/** Alice's personal workspace, with a paired machine she owns and a texting grant (`context_texts`) for her 1:1 chat. */
async function aJob(clientId = "context_texts", parentToken = PARENT) {
  const t = setupTest();
  const alice = await createUser(t, "alice@example.invalid");
  const alfa = await createWorkspace(t, alice, "alfa", { displayName: "Alice" });
  const parentId = await seedGrant(t, alfa, alice, clientId, await hashToken(`${parentToken}-refresh`), T0 + FIFTEEN_MINUTES);
  const hashedParent = await hashToken(parentToken);
  const machineId = await t.run(async (ctx) => {
    if ((await ctx.db.query("oauthClients").withIndex("by_clientId", (q) => q.eq("clientId", clientId)).unique()) === null) {
      await ctx.db.insert("oauthClients", {
        clientId,
        clientName: clientId,
        redirectUris: [],
        hashedClientSecret: null,
        tokenEndpointAuthMethod: "none",
        grantTypes: [],
        responseTypes: [],
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(parentId, { hashedAccessToken: hashedParent });
    return await ctx.db.insert("texMachines", {
      workspaceId: alfa,
      ownerId: alice,
      name: "a-laptop",
      os: "macos",
      publicKey: "A".repeat(43),
      hashedGrant: await hashToken(`tmg_${"x".repeat(40)}`),
      status: "active",
      createdAt: Date.now(),
    });
  });
  return { t, alice, alfa, parentId, machineId };
}

/** Mint a run grant from a parent token, as the job would; returns the gateway's answer. */
async function mint(
  t: TestConvex,
  machineId: Id<"texMachines">,
  body: { parentToken?: string; runId?: string; expiresAt?: number } = {},
) {
  return await gatewayPost(t, "/gateway/machines/run-grant", {
    parentToken: body.parentToken ?? PARENT,
    machineId,
    runId: body.runId ?? RUN_ID,
    expiresAt: body.expiresAt ?? Date.now() + 10 * MINUTE,
  });
}

async function mintedToken(t: TestConvex, machineId: Id<"texMachines">, body: Parameters<typeof mint>[2] = {}): Promise<string> {
  const response = await mint(t, machineId, body);
  expect(response.status).toBe(200);
  return (await json(response)).accessToken as string;
}

/** What `/gateway/session` sees for a presented token: the session the gateway would use, or null. */
async function sessionFor(t: TestConvex, accessToken: string) {
  return await t.query(internal.functions.controlPlane.resolveGrantByAccessToken, {
    hashedAccessToken: await hashToken(accessToken),
  });
}

describe("minting and resolving a run grant", () => {
  test("a run grant resolves a session as the run's client, acting as the parent's person, context and scopes", async () => {
    const { t, alice, alfa, parentId, machineId } = await aJob();
    const minted = await mint(t, machineId, { expiresAt: Date.now() + 10 * MINUTE });
    expect(minted.status).toBe(200);
    const body = await json(minted);
    const runExpiresAt = body.expiresAt as number;
    expect(body.accessToken).toMatch(/^cat_/);
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("texMachineRunGrants").collect()))).not.toContain(body.accessToken as string);

    const session = await sessionFor(t, body.accessToken as string);
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(session).toMatchObject({
      grantId: parentId,
      clientId: TEX_MACHINE_RUN_CLIENT_ID,
      clientName: "Tex on your computer",
      actorUserId: alice,
      scopes: parent!.scopes,
      expiresAt: runExpiresAt,
      workspaceId: alfa,
      role: "owner",
    });
    expect(session!.workspaces[0]).toMatchObject({ workspaceId: alfa, role: "owner" });
  });

  test("a run grant reads and is delivered the job note's mail its job's own grant joined, and no one else's", async () => {
    const { t, alfa, parentId, machineId } = await aJob();
    const token = await mintedToken(t, machineId);
    const post = async (path: string, body: Record<string, unknown>) => await json(await gatewayPost(t, path, body));
    const joined = (await post("/gateway/mail/join", { accessToken: PARENT, workspaceId: alfa, path: "projects/sign-in.md", name: "dev2", jobId: "job_aaaaaaaa" })) as { mailbox: { mailboxId: string } };
    const mailboxId = joined.mailbox.mailboxId;
    expect(((await post("/gateway/mail/get", { accessToken: token, mailboxId })) as { mailbox: { name: string } | null }).mailbox?.name).toBe("dev2");
    const boxes = ((await post("/gateway/mail/jobs", { accessToken: token, workspaceId: alfa, path: "projects/sign-in.md" })) as { mailboxes: Array<{ name: string; own: boolean }> }).mailboxes;
    expect(boxes).toEqual([expect.objectContaining({ name: "dev2", own: true })]);
    // Revoked with its parent: the run grant reaches no mailbox.
    await t.run((ctx) => ctx.db.patch(parentId, { status: "revoked" }));
    expect(((await post("/gateway/mail/get", { accessToken: token, mailboxId })) as { mailbox: unknown }).mailbox).toBeNull();
  });

  test("a run grant stops resolving when its parent texting grant is revoked", async () => {
    const { t, parentId, machineId } = await aJob();
    const token = await mintedToken(t, machineId);
    expect(await sessionFor(t, token)).not.toBeNull();

    await t.run((ctx) => ctx.db.patch(parentId, { status: "revoked" }));
    expect(await sessionFor(t, token)).toBeNull();
  });

  test("a run grant stops resolving when its machine is revoked, and the revoke deletes its rows", async () => {
    const { t, alice, machineId } = await aJob();
    const token = await mintedToken(t, machineId);
    expect(await sessionFor(t, token)).not.toBeNull();

    const revoked = await gatewayPost(t, "/gateway/machines/revoke", { machineId, userId: alice });
    expect(revoked.status).toBe(200);
    expect(await sessionFor(t, token)).toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("texMachineRunGrants").withIndex("by_machine", (q) => q.eq("machineId", machineId)).collect());
    expect(rows).toHaveLength(0);
  });

  test("a run grant stops at its own expiry while the parent is live, and outlives the parent token's expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { t, parentId, machineId } = await aJob();
    // The parent texting token expires after fifteen minutes; the run asks for two hours and is clamped to thirty.
    const minted = await mint(t, machineId, { expiresAt: T0 + 2 * 60 * MINUTE });
    const body = await json(minted);
    expect(body).toEqual({ accessToken: expect.any(String), expiresAt: T0 + TEX_MACHINE_RUN_MAX_MS });
    const token = body.accessToken as string;

    vi.setSystemTime(T0 + 20 * MINUTE);
    // The parent's own token has run out, so the texting path refuses it; the run still resolves.
    expect(await t.run(async (ctx) => await resolveLiveGrant(ctx, await hashToken(PARENT)))).toBeNull();
    expect(await sessionFor(t, token)).not.toBeNull();

    vi.setSystemTime(T0 + TEX_MACHINE_RUN_MAX_MS);
    expect(await sessionFor(t, token)).toBeNull();
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent!.status).toBe("active");
  });

  test("a run grant stops resolving while the person has paused sign-ins by phone, as their 1:1 texting grant does", async () => {
    const { t, alice, machineId } = await aJob();
    const token = await mintedToken(t, machineId);
    expect(await sessionFor(t, token)).not.toBeNull();

    // Guard: `phoneSignInPaused` in `resolveRunGrant`. Removing that line leaves the run resolving through the pause.
    const pauseId = await t.run((ctx) => ctx.db.insert("phoneSignInPauses", { userId: alice, pausedAt: Date.now() }));
    expect(await sessionFor(t, token)).toBeNull();
    await t.run((ctx) => ctx.db.delete(pauseId));
    expect(await sessionFor(t, token)).not.toBeNull();
  });

  test("resolveLiveGrant, the owner-clearance path, never resolves a run token", async () => {
    const { t, machineId } = await aJob();
    const token = await mintedToken(t, machineId);
    const found = await t.run(async (ctx) => await resolveLiveGrant(ctx, await hashToken(token)));
    expect(found).toBeNull();
    // Guard: `resolveLiveGrant` reads only `oauthGrants`. Teaching it the run table would make this resolve.
    expect(await sessionFor(t, token)).not.toBeNull();
  });

  test("minting from a parent that is not a texting client is refused, and so is a parent that is not live", async () => {
    const { t, machineId } = await aJob("claude-desktop", OTHER_PARENT);
    const refused = await mint(t, machineId, { parentToken: OTHER_PARENT });
    expect(refused.status).toBe(401);
    expect((await json(refused)).code).toBe("MACHINE_RUN_PARENT_INVALID");

    const unknown = await mint(t, machineId, { parentToken: `cat_${"z".repeat(40)}` });
    expect(unknown.status).toBe(401);
    expect((await json(unknown)).code).toBe("MACHINE_RUN_PARENT_INVALID");
  });

  test("a bad run id, an expiry already past, or a machine that is not active is refused", async () => {
    const { t, machineId } = await aJob();
    const badId = await mint(t, machineId, { runId: "run_NOTHEX" });
    expect(badId.status).toBe(400);
    expect((await json(badId)).code).toBe("BAD_RUN");

    const past = await mint(t, machineId, { expiresAt: Date.now() - 1 });
    expect((await json(past)).code).toBe("BAD_RUN");

    const missingMachine = await mint(t, "not-a-machine" as Id<"texMachines">);
    expect(missingMachine.status).toBe(404);
    expect((await json(missingMachine)).code).toBe("MACHINE_NOT_FOUND");
  });

  test("a mail-only device (a session's own computer) never gets a run grant: it takes mail, not jobs", async () => {
    const { t, machineId } = await aJob();
    await t.run((ctx) => ctx.db.patch(machineId, { mailOnly: true, expiresAt: Date.now() + 60 * MINUTE }));
    const refused = await mint(t, machineId);
    expect(refused.status).toBe(404);
    expect((await json(refused)).code).toBe("MACHINE_NOT_FOUND");
    expect(await t.run((ctx) => ctx.db.query("texMachineRunGrants").collect())).toEqual([]);
  });
});

describe("revoking and sweeping run grants", () => {
  test("revoking by run id deletes that run's grants only, and a second revoke deletes nothing", async () => {
    const { t, machineId } = await aJob();
    const token = await mintedToken(t, machineId, { runId: RUN_ID });
    const other = await mintedToken(t, machineId, { runId: OTHER_RUN_ID });

    const first = await gatewayPost(t, "/gateway/machines/run-grant/revoke", { runId: RUN_ID });
    expect(await json(first)).toEqual({ revoked: 1 });
    expect(await sessionFor(t, token)).toBeNull();
    expect(await sessionFor(t, other)).not.toBeNull();

    const second = await gatewayPost(t, "/gateway/machines/run-grant/revoke", { runId: RUN_ID });
    expect(await json(second)).toEqual({ revoked: 0 });
  });

  test("the hourly purge deletes run grants past their expiry and keeps live ones", async () => {
    const { t, parentId, machineId } = await aJob();
    const live = await mintedToken(t, machineId, { runId: OTHER_RUN_ID });
    const expiredId = await t.run((ctx) =>
      ctx.db.insert("texMachineRunGrants", {
        hashedAccessToken: "e".repeat(64),
        parentGrantId: parentId,
        machineId,
        runId: RUN_ID,
        expiresAt: Date.now() - 1000,
        createdAt: Date.now() - 60 * MINUTE,
      }),
    );

    const result = await t.mutation(internal.functions.texMachines.purgeExpiredTexMachinePairings, {});
    expect(result).toEqual({ deleted: 1, moreRemaining: false });
    expect(await t.run((ctx) => ctx.db.get(expiredId))).toBeNull();
    expect(await sessionFor(t, live)).not.toBeNull();
  });
});
