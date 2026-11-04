/**
 * A session's own computer as a mail-only device (`functions/texMachineDevices.ts`,
 * `docs/decisions/texting-assistant/machines.md`, "A cloud VM as a mail-only device").
 *
 * A cloud VM's Claude Code session approves the code its own runner shows, with the Context connection it already
 * has. The machine it becomes takes note mail and never jobs, belongs to that connection's person and workspace,
 * ends with that connection, ends a day after it was paired, and leaves when its session ends. Every value here is
 * fake, and the repository is public.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, gatewayPost } from "./fixtures.helpers";
import { ACCESS_A, ACCESS_B, bodyOf, registerClient, seedConnectedClient, token, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { MAIL_ONLY_DEVICE_TTL_MS } from "../functions/lib/texMachineRules";
import { TEXTS_CLIENT_ID } from "../functions/textLinks";

const CODE = "KQ7-4MP";
const PUBLIC_KEY = "A".repeat(43);
const GRANT = `cmg_${"1".repeat(64)}`;
const OTHER_GRANT = `cmg_${"2".repeat(64)}`;

afterEach(() => {
  vi.useRealTimers();
});

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

async function startPairing(t: Tenants["t"], code = CODE) {
  const response = await gatewayPost(t, "/gateway/machines/pair/start", {
    code,
    publicKey: PUBLIC_KEY,
    name: "Claude Code · context",
    os: "linux",
    facts: { version: "0.2.0" },
  });
  expect(response.status).toBe(200);
  return (await bodyOf(response)).pairingId as string;
}

async function approveFromGrant(t: Tenants["t"], accessToken: string, workspaceId: string, code = CODE) {
  return await gatewayPost(t, "/gateway/machines/pair/approve-grant", { accessToken, workspaceId, code });
}

/** A device paired by alice's MCP connection: started, approved from the grant, claimed. */
async function aDevice(tenants: Tenants, grant = GRANT, code = CODE) {
  const pairingId = await startPairing(tenants.t, code);
  expect((await approveFromGrant(tenants.t, ACCESS_A, tenants.aliceWs, code)).status).toBe(200);
  const claimed = await gatewayPost(tenants.t, "/gateway/machines/pair/claim", { pairingId, grant });
  expect(claimed.status).toBe(200);
  return await bodyOf(claimed);
}

const resolve = (t: Tenants["t"], grant = GRANT) => gatewayPost(t, "/gateway/machines/resolve", { grant });

describe("pairing from a session's own connection", () => {
  test("approves as the connection's person, into its workspace, as a mail-only device that ends in a day", async () => {
    const tenants = await twoConnectedTenants();
    const pairingId = await startPairing(tenants.t);
    const approved = await approveFromGrant(tenants.t, ACCESS_A, tenants.aliceWs);
    expect(approved.status).toBe(200);
    expect(await bodyOf(approved)).toEqual({ name: "Claude Code · context", os: "linux" });

    const before = Date.now();
    const claimed = await bodyOf(await gatewayPost(tenants.t, "/gateway/machines/pair/claim", { pairingId, grant: GRANT }));
    expect(claimed).toMatchObject({ workspaceId: tenants.aliceWs, ownerId: tenants.alice, mailOnly: true });
    expect(claimed.expiresAt).toBeGreaterThanOrEqual(before + MAIL_ONLY_DEVICE_TTL_MS);
    expect(claimed.expiresAt).toBeLessThanOrEqual(Date.now() + MAIL_ONLY_DEVICE_TTL_MS);

    const row = await tenants.t.run((ctx) => ctx.db.get(claimed.machineId as Id<"texMachines">));
    expect(row).toMatchObject({ mailOnly: true, pairedByGrantId: tenants.grantA, status: "active" });
    expect((await bodyOf(await resolve(tenants.t))).mailOnly).toBe(true);
  });

  test("a code approved in the app is a full machine: only a session's own connection makes a mail-only one", async () => {
    const tenants = await twoConnectedTenants();
    const pairingId = await startPairing(tenants.t);
    await asUser(tenants.t, tenants.alice).action(api.functions.texMachines.approveTexMachinePairing, { code: CODE, workspaceId: tenants.aliceWs });
    const claimed = await bodyOf(await gatewayPost(tenants.t, "/gateway/machines/pair/claim", { pairingId, grant: GRANT }));
    expect(claimed.mailOnly).toBeUndefined();
    expect(claimed.expiresAt).toBeUndefined();
    const row = await tenants.t.run((ctx) => ctx.db.get(claimed.machineId as Id<"texMachines">));
    expect(row?.mailOnly).toBeUndefined();
    expect(row?.pairedByGrantId).toBeUndefined();
  });

  test("a workspace other than the connection's own is refused, and the code stays waiting", async () => {
    const tenants = await twoConnectedTenants();
    await startPairing(tenants.t);
    expect((await approveFromGrant(tenants.t, ACCESS_A, tenants.bobWs)).status).toBe(404);
    const pairing = await tenants.t.run((ctx) => ctx.db.query("texMachinePairings").first());
    expect(pairing?.status).toBe("waiting");
  });

  test("an unknown or revoked connection is refused as unauthorized", async () => {
    const tenants = await twoConnectedTenants();
    await startPairing(tenants.t);
    expect((await approveFromGrant(tenants.t, token("nobody"), tenants.aliceWs)).status).toBe(401);
    await tenants.t.run((ctx) => ctx.db.patch(tenants.grantA, { status: "revoked" }));
    expect((await approveFromGrant(tenants.t, ACCESS_A, tenants.aliceWs)).status).toBe(401);
  });

  test("a wrong code is not found, and Tex's own texting connection may not pair a device", async () => {
    const tenants = await twoConnectedTenants();
    await startPairing(tenants.t);
    expect((await approveFromGrant(tenants.t, ACCESS_A, tenants.aliceWs, "ZZZ-ZZZ")).status).toBe(404);
    expect((await approveFromGrant(tenants.t, ACCESS_A, tenants.aliceWs, "nonsense")).status).toBe(404);

    await registerClient(tenants.t, TEXTS_CLIENT_ID);
    const texting = token("alice_texting");
    await seedConnectedClient(tenants.t, { workspaceId: tenants.aliceWs, userId: tenants.alice, clientId: TEXTS_CLIENT_ID, accessToken: texting });
    expect((await approveFromGrant(tenants.t, texting, tenants.aliceWs)).status).toBe(403);
  });

  test("guessing codes spends the connection's person's budget, wrong codes included", async () => {
    const tenants = await twoConnectedTenants();
    for (let i = 0; i < 10; i += 1) {
      expect((await approveFromGrant(tenants.t, ACCESS_A, tenants.aliceWs, "ZZZ-ZZZ")).status).toBe(404);
    }
    await startPairing(tenants.t);
    expect((await approveFromGrant(tenants.t, ACCESS_A, tenants.aliceWs)).status).toBe(429);
  });
});

describe("a mail-only device's life", () => {
  test("it ends with the connection that paired it", async () => {
    const tenants = await twoConnectedTenants();
    await aDevice(tenants);
    expect((await resolve(tenants.t)).status).toBe(200);
    await tenants.t.run((ctx) => ctx.db.patch(tenants.grantA, { status: "revoked" }));
    expect((await resolve(tenants.t)).status).toBe(401);
  });

  test("it ends a day after it was paired, and the purge removes it with its mailboxes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2030, 0, 1));
    const tenants = await twoConnectedTenants();
    const device = await aDevice(tenants);
    await gatewayPost(tenants.t, "/gateway/mail/join", { accessToken: ACCESS_A, workspaceId: tenants.aliceWs, path: "n.md", name: "vm", machineId: device.machineId });

    vi.setSystemTime(Date.UTC(2030, 0, 1) + MAIL_ONLY_DEVICE_TTL_MS + 1);
    // The paired connection's own token has run out too; it is the grant's standing that counts, not the token's time.
    expect((await resolve(tenants.t)).status).toBe(401);

    vi.setSystemTime(Date.UTC(2030, 0, 1) + MAIL_ONLY_DEVICE_TTL_MS + 2 * 60 * 60 * 1000);
    await tenants.t.mutation(internal.functions.texMachines.purgeExpiredTexMachinePairings, {});
    const left = await tenants.t.run(async (ctx) => ({
      machines: await ctx.db.query("texMachines").collect(),
      mailboxes: await ctx.db.query("noteMailboxes").collect(),
    }));
    expect(left).toEqual({ machines: [], mailboxes: [] });
  });

  test("leaving gives the grant back once: the machine is revoked, and a second leave is unauthorized", async () => {
    const tenants = await twoConnectedTenants();
    const device = await aDevice(tenants);
    const left = await gatewayPost(tenants.t, "/gateway/machines/leave", { grant: GRANT });
    expect(left.status).toBe(200);
    expect(await bodyOf(left)).toEqual({ machineId: device.machineId, workspaceId: tenants.aliceWs });
    expect((await resolve(tenants.t)).status).toBe(401);
    expect((await gatewayPost(tenants.t, "/gateway/machines/leave", { grant: GRANT })).status).toBe(401);
    expect((await gatewayPost(tenants.t, "/gateway/machines/leave", { grant: OTHER_GRANT })).status).toBe(401);
  });
});

describe("mail to a device", () => {
  type Box = { mailboxId: string; name: string; jobId?: string; machineId?: string; machineWorkspaceId?: string; own: boolean };
  const boxes = async (t: Tenants["t"], accessToken: string, workspaceId: string, path: string) =>
    ((await bodyOf(await gatewayPost(t, "/gateway/mail/jobs", { accessToken, workspaceId, path }))) as { mailboxes: Box[] }).mailboxes;

  test("a session joins a note's mail as its own device, and the gateway is told where to push it", async () => {
    const tenants = await twoConnectedTenants();
    const device = await aDevice(tenants);
    const joined = await bodyOf(
      await gatewayPost(tenants.t, "/gateway/mail/join", { accessToken: ACCESS_A, workspaceId: tenants.aliceWs, path: "n.md", name: "vm-builder", machineId: device.machineId }),
    );
    expect(joined.mailbox).toBeDefined();
    expect(await boxes(tenants.t, ACCESS_A, tenants.aliceWs, "n.md")).toEqual([
      expect.objectContaining({ name: "vm-builder", machineId: device.machineId, machineWorkspaceId: tenants.aliceWs, own: true }),
    ]);
  });

  test("a device someone else owns, or none at all, is refused", async () => {
    const tenants = await twoConnectedTenants();
    const device = await aDevice(tenants);
    const join = (accessToken: string, workspaceId: string, machineId: string) =>
      gatewayPost(tenants.t, "/gateway/mail/join", { accessToken, workspaceId, path: "n.md", name: "vm", machineId }).then(bodyOf);
    expect(await join(ACCESS_B, tenants.bobWs, device.machineId as string)).toEqual({ error: "refused" });
    expect(await join(ACCESS_A, tenants.aliceWs, "not-a-machine")).toEqual({ error: "refused" });
  });

  test("a device that left is no longer pushed to", async () => {
    const tenants = await twoConnectedTenants();
    const device = await aDevice(tenants);
    await gatewayPost(tenants.t, "/gateway/mail/join", { accessToken: ACCESS_A, workspaceId: tenants.aliceWs, path: "n.md", name: "vm", machineId: device.machineId });
    await gatewayPost(tenants.t, "/gateway/machines/leave", { grant: GRANT });
    expect(await boxes(tenants.t, ACCESS_A, tenants.aliceWs, "n.md")).toEqual([]);
  });
});
