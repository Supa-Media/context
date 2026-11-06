/**
 * Tex machines: pairing a person's own computer, claiming its grant, resolving it, and revoking it.
 *
 * The gateway holds the signature and grant rules; the control plane decides who may approve, claim, register and
 * revoke, and stores only hashes. Every value here is fake, and the repository is public.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { mayOwnTexMachine, normalizePairingCode } from "../functions/lib/texMachineRules";
import {
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  gatewayPost,
  setupTest,
} from "./fixtures.helpers";

const CODE = "KQ7-4MP";
const PUBLIC_KEY = "A".repeat(43);
const OTHER_KEY = "B".repeat(43);
/** A fake machine grant. The plain value is returned once to the runner; the control plane must never keep it. */
const GRANT = `tmg_${"x".repeat(40)}`;
const TEN_MINUTES = 10 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

const FACTS = { version: "0.1.0", cores: 8, memoryGb: 16 };

async function startPairing(t: TestConvex, code = CODE, publicKey = PUBLIC_KEY, facts: unknown = FACTS) {
  return gatewayPost(t, "/gateway/machines/pair/start", { code, publicKey, name: "a-laptop", os: "macos", facts });
}

async function pairingIdOf(t: TestConvex, code = CODE, publicKey = PUBLIC_KEY): Promise<string> {
  const response = await startPairing(t, code, publicKey);
  expect(response.status).toBe(200);
  return (await json(response)).pairingId as string;
}

async function approve(t: TestConvex, userId: Id<"users">, workspaceId: Id<"workspaces">, code = CODE) {
  return await asUser(t, userId).action(api.functions.texMachines.approveTexMachinePairing, { code, workspaceId });
}

async function claim(t: TestConvex, pairingId: string, grant = GRANT) {
  return gatewayPost(t, "/gateway/machines/pair/claim", { pairingId, grant });
}

async function resolve(t: TestConvex, grant = GRANT) {
  return gatewayPost(t, "/gateway/machines/resolve", { grant });
}

/** A personal workspace owned by alice, with a shared one she owns, and bob and carol as a member and an editor. */
async function aFamily() {
  const t = setupTest();
  const alice = await createUser(t, "alice@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");
  const carol = await createUser(t, "carol@example.invalid");
  const alfa = await createWorkspace(t, alice, "alfa", { displayName: "Alice" });
  const team = await createWorkspace(t, alice, "household", { displayName: "Household", kind: "shared" });
  await addMember(t, team, bob, "member", alice);
  await addMember(t, team, carol, "editor", alice);
  return { t, alice, bob, carol, alfa, team };
}

describe("the role rule", () => {
  test("a personal workspace is owned only by its owner", () => {
    expect(mayOwnTexMachine("personal", "owner")).toBe(true);
    expect(mayOwnTexMachine("personal", "editor")).toBe(false);
    expect(mayOwnTexMachine("personal", "member")).toBe(false);
  });

  test("a shared workspace is owned by an owner or an editor, never a member", () => {
    expect(mayOwnTexMachine("shared", "owner")).toBe(true);
    expect(mayOwnTexMachine("shared", "editor")).toBe(true);
    expect(mayOwnTexMachine("shared", "member")).toBe(false);
  });

  test("a pairing code normalizes case and punctuation, and must be six characters", () => {
    expect(normalizePairingCode("kq7-4mp")).toBe("KQ74MP");
    expect(normalizePairingCode(" KQ7 4MP ")).toBe("KQ74MP");
    expect(normalizePairingCode("KQ7-4M")).toBeNull();
    expect(normalizePairingCode("KQ7-4MPX")).toBeNull();
  });
});

describe("pairing, claim and resolve", () => {
  test("a personal owner approves, the runner claims, and the grant resolves to the machine", async () => {
    const { t, alice, alfa } = await aFamily();
    const pairingId = await pairingIdOf(t);

    const read = await json(await gatewayPost(t, "/gateway/machines/pair/read", { pairingId }));
    expect(read).toEqual({
      status: "waiting",
      publicKey: PUBLIC_KEY,
      expired: false,
      name: "a-laptop",
      os: "macos",
      facts: FACTS,
    });

    const approved = await approve(t, alice, alfa);
    expect(approved).toEqual({ pairingId, name: "a-laptop", os: "macos" });

    const readApproved = await json(await gatewayPost(t, "/gateway/machines/pair/read", { pairingId }));
    expect(readApproved.status).toBe("approved");

    const claimed = await claim(t, pairingId);
    expect(claimed.status).toBe(200);
    const machine = await json(claimed);
    expect(machine).toEqual({
      machineId: expect.any(String),
      workspaceId: alfa,
      ownerId: alice,
      name: "a-laptop",
      workspaceHandle: "alfa",
    });

    const row = await t.run((ctx) => ctx.db.get(machine.machineId as Id<"texMachines">));
    expect(row!.hashedGrant).toBe(await hashToken(GRANT));
    expect(row!.hashedGrant).not.toBe(GRANT);
    expect(JSON.stringify(row)).not.toContain(GRANT);

    const resolved = await resolve(t);
    expect(resolved.status).toBe(200);
    expect(await json(resolved)).toEqual({
      machineId: machine.machineId,
      workspaceId: alfa,
      ownerId: alice,
      name: "a-laptop",
      os: "macos",
      publicKey: PUBLIC_KEY,
    });
  });

  test("a claim before approval is refused, and a second claim is a conflict", async () => {
    const { t, alice, alfa } = await aFamily();
    const pairingId = await pairingIdOf(t);

    const early = await claim(t, pairingId);
    expect(early.status).toBe(409);
    expect((await json(early)).code).toBe("PAIRING_NOT_APPROVED");

    await approve(t, alice, alfa);
    expect((await claim(t, pairingId)).status).toBe(200);

    const again = await claim(t, pairingId, `tmg_${"y".repeat(40)}`);
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe("PAIRING_ALREADY_CLAIMED");
  });

  test("approving after the code expired is refused, and claiming long after approval is refused", async () => {
    const { t, alice, alfa } = await aFamily();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2030, 0, 1));

    const expiring = await pairingIdOf(t, "AAA-111", OTHER_KEY);
    vi.setSystemTime(Date.UTC(2030, 0, 1) + TEN_MINUTES + 1);
    const expiredRead = await json(await gatewayPost(t, "/gateway/machines/pair/read", { pairingId: expiring }));
    expect(expiredRead).toEqual({
      status: "waiting",
      publicKey: OTHER_KEY,
      expired: true,
      name: "a-laptop",
      os: "macos",
      facts: FACTS,
    });
    const lateApproval = await captureError(() => approve(t, alice, alfa, "AAA-111"));
    expect(errorCode(lateApproval)).toBe("PAIRING_NOT_FOUND");

    vi.setSystemTime(Date.UTC(2030, 0, 1));
    const pairingId = await pairingIdOf(t);
    await approve(t, alice, alfa);
    vi.setSystemTime(Date.UTC(2030, 0, 1) + 2 * TEN_MINUTES + 1);
    const stale = await claim(t, pairingId);
    expect(stale.status).toBe(410);
    expect((await json(stale)).code).toBe("PAIRING_EXPIRED");
  });

  test("a member of a shared workspace cannot approve, and an editor can", async () => {
    const { t, bob, carol, team } = await aFamily();
    await pairingIdOf(t);
    const memberTry = await captureError(() => approve(t, bob, team));
    expect(errorCode(memberTry)).toBe("INSUFFICIENT_ROLE");

    const editorTry = await approve(t, carol, team);
    expect(editorTry).toEqual({ pairingId: expect.any(String), name: "a-laptop", os: "macos" });
  });

  test("a user who is not a member of the workspace cannot approve it", async () => {
    const { t, bob, alfa } = await aFamily();
    await pairingIdOf(t);
    const outsider = await captureError(() => approve(t, bob, alfa));
    expect(errorCode(outsider)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("approvals are rate limited per person, and refused attempts still count", async () => {
    const { t, alice, alfa } = await aFamily();
    await pairingIdOf(t);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await captureError(() => approve(t, alice, alfa, "ZZZ-999"));
      expect(errorCode(wrong)).toBe("PAIRING_NOT_FOUND");
    }
    const limited = await captureError(() => approve(t, alice, alfa));
    expect(errorCode(limited)).toBe("RATE_LIMITED");
  });

  test("facts are required, must be an object, and are refused past 8000 characters", async () => {
    const { t } = await aFamily();
    const missing = await gatewayPost(t, "/gateway/machines/pair/start", {
      code: CODE, publicKey: PUBLIC_KEY, name: "a-laptop", os: "macos",
    });
    expect(missing.status).toBe(400);
    const notObject = await startPairing(t, CODE, PUBLIC_KEY, ["not", "an", "object"]);
    expect(notObject.status).toBe(400);
    const huge = await startPairing(t, CODE, PUBLIC_KEY, { blob: "x".repeat(8001) });
    expect(huge.status).toBe(400);
    const fits = await startPairing(t, CODE, PUBLIC_KEY, { blob: "x".repeat(7000) });
    expect(fits.status).toBe(200);
  });

  test("a live code cannot be started again, and a code is matched however it is typed", async () => {
    const { t } = await aFamily();
    await pairingIdOf(t);

    const same = await startPairing(t, CODE, OTHER_KEY);
    expect(same.status).toBe(409);
    expect((await json(same)).code).toBe("CODE_TAKEN");

    const retyped = await startPairing(t, "kq7 4mp", OTHER_KEY);
    expect(retyped.status).toBe(409);
    expect((await json(retyped)).code).toBe("CODE_TAKEN");
  });
});

describe("the app's look-up, decline and register", () => {
  test("a person sees a waiting code's details, and a declined one is gone", async () => {
    const { t, alice } = await aFamily();
    await pairingIdOf(t);

    const pending = await asUser(t, alice).action(api.functions.texMachines.pendingTexMachinePairing, { code: "kq7-4mp" });
    expect(pending).toEqual({ name: "a-laptop", os: "macos", createdAt: expect.any(Number), expiresAt: expect.any(Number) });
    const wrong = await asUser(t, alice).action(api.functions.texMachines.pendingTexMachinePairing, { code: "ZZZ-999" });
    expect(wrong).toBeNull();

    await asUser(t, alice).action(api.functions.texMachines.declineTexMachinePairing, { code: CODE });
    const after = await asUser(t, alice).action(api.functions.texMachines.pendingTexMachinePairing, { code: CODE });
    expect(after).toBeNull();
    const declineAgain = await captureError(() =>
      asUser(t, alice).action(api.functions.texMachines.declineTexMachinePairing, { code: CODE }),
    );
    expect(errorCode(declineAgain)).toBe("PAIRING_NOT_FOUND");
  });

  test("the Mac app registers its own machine for a member who may own one", async () => {
    const { t, alice, bob, alfa, team } = await aFamily();
    const registered = await gatewayPost(t, "/gateway/machines/register", {
      userId: alice,
      workspaceId: alfa,
      grant: GRANT,
      publicKey: PUBLIC_KEY,
      name: "this-mac",
      os: "macos",
    });
    expect(registered.status).toBe(200);
    expect(await json(registered)).toEqual({
      machineId: expect.any(String),
      workspaceId: alfa,
      ownerId: alice,
      name: "this-mac",
      workspaceHandle: "alfa",
    });
    expect((await resolve(t)).status).toBe(200);

    const memberTry = await gatewayPost(t, "/gateway/machines/register", {
      userId: bob,
      workspaceId: team,
      grant: `tmg_${"q".repeat(40)}`,
      publicKey: OTHER_KEY,
      name: "bobs-mac",
      os: "macos",
    });
    expect(memberTry.status).toBe(403);
    expect((await json(memberTry)).code).toBe("INSUFFICIENT_ROLE");
  });
});

describe("resolve and revoke", () => {
  test("a revoked grant resolves to nothing, and an owner removed from the workspace loses the machine", async () => {
    const { t, carol, team } = await aFamily();
    const pairingId = await pairingIdOf(t);
    await approve(t, carol, team);
    const machine = await json(await claim(t, pairingId));

    const revoke = await gatewayPost(t, "/gateway/machines/revoke", { machineId: machine.machineId, userId: carol });
    expect(await json(revoke)).toEqual({ revoked: true, workspaceId: team });
    const afterRevoke = await resolve(t);
    expect(afterRevoke.status).toBe(401);
    expect((await json(afterRevoke)).code).toBe("MACHINE_GRANT_INVALID");

    const secondPairing = await pairingIdOf(t, "CCC-333", OTHER_KEY);
    await approve(t, carol, team, "CCC-333");
    await claim(t, secondPairing, `tmg_${"z".repeat(40)}`);
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", team).eq("userId", carol))
        .unique();
      await ctx.db.delete(membership!._id);
    });
    const gone = await gatewayPost(t, "/gateway/machines/resolve", { grant: `tmg_${"z".repeat(40)}` });
    expect(gone.status).toBe(403);
    expect((await json(gone)).code).toBe("MACHINE_OWNER_GONE");
  });

  test("a stranger's revoke is indistinguishable from an unknown machine; the owner's revoke works", async () => {
    const { t, alice, bob, alfa } = await aFamily();
    const pairingId = await pairingIdOf(t);
    await approve(t, alice, alfa);
    const machine = await json(await claim(t, pairingId));

    const stranger = await gatewayPost(t, "/gateway/machines/revoke", { machineId: machine.machineId, userId: bob });
    expect(stranger.status).toBe(404);
    const strangerBody = await json(stranger);
    expect(strangerBody.code).toBe("MACHINE_NOT_FOUND");
    const unknown = await gatewayPost(t, "/gateway/machines/revoke", {
      machineId: "not-a-real-machine",
      userId: alice,
    });
    expect(await json(unknown)).toEqual(strangerBody);

    const stillActive = await t.run((ctx) => ctx.db.get(machine.machineId as Id<"texMachines">));
    expect(stillActive!.status).toBe("active");

    const owner = await gatewayPost(t, "/gateway/machines/revoke", { machineId: machine.machineId, userId: alice });
    expect(await json(owner)).toEqual({ revoked: true, workspaceId: alfa });
    const again = await gatewayPost(t, "/gateway/machines/revoke", { machineId: machine.machineId, userId: alice });
    expect(await json(again)).toEqual({ revoked: true, workspaceId: alfa });
  });

  test("the app's list never carries a grant hash", async () => {
    const { t, alice, alfa } = await aFamily();
    const pairingId = await pairingIdOf(t);
    await approve(t, alice, alfa);
    await claim(t, pairingId);

    const list = await asUser(t, alice).query(api.functions.texMachines.listTexMachines, { workspaceId: alfa });
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      _id: expect.any(String),
      name: "a-laptop",
      os: "macos",
      ownerId: alice,
      status: "active",
      createdAt: expect.any(Number),
      lastSeenAt: undefined,
      revokedAt: undefined,
    });
    expect(JSON.stringify(list)).not.toContain("hashedGrant");
  });

  test("a non-member cannot list a workspace's machines", async () => {
    const { t, bob, alfa } = await aFamily();
    const error = await captureError(() =>
      asUser(t, bob).query(api.functions.texMachines.listTexMachines, { workspaceId: alfa }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("the gateway's door and the sweep", () => {
  test("every machine route refuses a missing or wrong gateway secret the same way", async () => {
    const { t } = await aFamily();
    const routes = [
      "/gateway/machines/pair/start",
      "/gateway/machines/pair/read",
      "/gateway/machines/pair/claim",
      "/gateway/machines/resolve",
      "/gateway/machines/register",
      "/gateway/machines/revoke",
    ];
    for (const path of routes) {
      const none = await gatewayPost(t, path, { grant: GRANT }, { secret: null });
      const wrong = await gatewayPost(t, path, { grant: GRANT }, { secret: "not-the-secret" });
      expect(none.status, path).toBe(401);
      expect(wrong.status, path).toBe(401);
      expect(await none.text(), path).toBe(await wrong.text());
    }
  });

  test("the purge removes pairings an hour past expiry and keeps the recent ones", async () => {
    const { t } = await aFamily();
    const now = Date.now();
    const base = { publicKey: PUBLIC_KEY, name: "old", os: "linux", status: "waiting" as const, createdAt: now };
    const oldId = await t.run((ctx) =>
      ctx.db.insert("texMachinePairings", { ...base, hashedCode: "a".repeat(64), expiresAt: now - 61 * 60 * 1000 }),
    );
    const recentId = await t.run((ctx) =>
      ctx.db.insert("texMachinePairings", { ...base, hashedCode: "b".repeat(64), expiresAt: now - 30 * 60 * 1000 }),
    );

    const result = await t.mutation(internal.functions.texMachines.purgeExpiredTexMachinePairings, {});
    expect(result).toEqual({ deleted: 1, moreRemaining: false });
    expect(await t.run((ctx) => ctx.db.get(oldId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(recentId))).not.toBeNull();
  });
});

describe("deletion", () => {
  async function pairedInto(t: TestConvex, approver: Id<"users">, workspaceId: Id<"workspaces">, code: string, grant: string) {
    const pairingId = await pairingIdOf(t, code);
    await approve(t, approver, workspaceId, code);
    expect((await claim(t, pairingId, grant)).status).toBe(200);
  }

  test("a deleted workspace takes its computers' grants with it", async () => {
    const { t, alice, team } = await aFamily();
    await pairedInto(t, alice, team, "AAA-BBB", `${GRANT}1`);
    const { finalizeWorkspaceDeletion } = await import("../functions/lib/account/finalizeWorkspaceDeletion");
    await t.run(async (ctx) => await finalizeWorkspaceDeletion(ctx, team));
    const left = await t.run(async (ctx) => await ctx.db.query("texMachines").collect());
    expect(left).toHaveLength(0);
    expect((await resolve(t, `${GRANT}1`)).status).toBe(401);
  });

  test("a deleted person takes the computers they paired into workspaces that live on", async () => {
    const { t, alice, carol, team } = await aFamily();
    await pairedInto(t, carol, team, "CCC-DDD", `${GRANT}2`);
    await pairedInto(t, alice, team, "EEE-FFF", `${GRANT}3`);
    const { deletePersonalRows } = await import("../functions/lib/account/personalRows");
    await t.run(async (ctx) => await deletePersonalRows(ctx, carol));
    const left = await t.run(async (ctx) => await ctx.db.query("texMachines").collect());
    expect(left.map((row) => row.ownerId)).toEqual([alice]);
  });

  test("looking codes up spends the same attempt budget as approving them", async () => {
    const { t, bob } = await aFamily();
    for (let i = 0; i < 10; i += 1) await asUser(t, bob).action(api.functions.texMachines.pendingTexMachinePairing, { code: "ZZZ-ZZZ" });
    const refused = await captureError(() => asUser(t, bob).action(api.functions.texMachines.pendingTexMachinePairing, { code: "ZZZ-ZZZ" }));
    expect(refused).toBeTruthy();
  });
});
