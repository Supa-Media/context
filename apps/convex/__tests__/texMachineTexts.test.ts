/**
 * Setting up a person's own computer by texting Tex (`functions/texMachineTexts.ts`,
 * `docs/decisions/texting-assistant/computer-setup.md`).
 *
 * A code the person texts Tex in their own 1:1 is approved as a full computer in their own workspace, as one approved
 * in the app is. A group chat's grant, an MCP connection and a job's run grant never approve one here. Every value is
 * fake, and the repository is public.
 *
 * Sabotage: dropping the client check in `approveTexMachinePairingFromTexts` fails "only their own texts"; dropping
 * the rate limit fails "guessing spends the budget"; reading `by_owner` without the mailOnly filter fails "own
 * computers only".
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { gatewayPost } from "./fixtures.helpers";
import { ACCESS_A, bodyOf, registerClient, seedConnectedClient, token, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { TEXTS_CLIENT_ID } from "../functions/textLinks";
import { TEXTS_GROUP_CLIENT_ID } from "../functions/textGroups";

const CODE = "KQ7-4MP";
const PUBLIC_KEY = "A".repeat(43);
const GRANT = `cmg_${"3".repeat(64)}`;

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

async function startPairing(t: Tenants["t"], code = CODE) {
  const response = await gatewayPost(t, "/gateway/machines/pair/start", {
    code,
    publicKey: PUBLIC_KEY,
    name: "Jhon's MacBook Air",
    os: "macos",
    facts: { version: "0.2.5" },
  });
  expect(response.status).toBe(200);
  return (await bodyOf(response)).pairingId as string;
}

async function texting(tenants: Tenants, clientId = TEXTS_CLIENT_ID) {
  await registerClient(tenants.t, clientId);
  const accessToken = token(`alice_${clientId}`);
  await seedConnectedClient(tenants.t, { workspaceId: tenants.aliceWs, userId: tenants.alice, clientId, accessToken });
  return accessToken;
}

const approve = (t: Tenants["t"], accessToken: string, code = CODE) =>
  gatewayPost(t, "/gateway/machines/pair/approve-texts", { accessToken, code });

describe("a pairing code texted to Tex", () => {
  test("is approved as the texter, into their own workspace, as a full computer", async () => {
    const tenants = await twoConnectedTenants();
    const pairingId = await startPairing(tenants.t);
    const accessToken = await texting(tenants);
    const approved = await approve(tenants.t, accessToken, "kq74mp");
    expect(approved.status).toBe(200);
    expect(await bodyOf(approved)).toEqual({ name: "Jhon's MacBook Air", os: "macos", workspaceId: tenants.aliceWs });

    const claimed = await bodyOf(await gatewayPost(tenants.t, "/gateway/machines/pair/claim", { pairingId, grant: GRANT }));
    expect(claimed).toMatchObject({ workspaceId: tenants.aliceWs, ownerId: tenants.alice });
    expect(claimed.mailOnly).toBeUndefined();
    const row = await tenants.t.run((ctx) => ctx.db.get(claimed.machineId as Id<"texMachines">));
    expect(row?.mailOnly).toBeUndefined();
    expect(row?.status).toBe("active");
  });

  test("only their own texts: a group chat's grant and an MCP connection are refused, and the code stays waiting", async () => {
    const tenants = await twoConnectedTenants();
    await startPairing(tenants.t);
    const group = await texting(tenants, TEXTS_GROUP_CLIENT_ID);
    // A group grant with no chat behind it does not even resolve; either way it approves nothing.
    expect([401, 403]).toContain((await approve(tenants.t, group)).status);
    expect((await approve(tenants.t, ACCESS_A)).status).toBe(403);
    const rows = await tenants.t.run((ctx) => ctx.db.query("texMachinePairings").collect());
    expect(rows.map((row) => row.status)).toEqual(["waiting"]);
  });

  test("an unknown, malformed or dead token approves nothing", async () => {
    const tenants = await twoConnectedTenants();
    await startPairing(tenants.t);
    const accessToken = await texting(tenants);
    expect((await approve(tenants.t, accessToken, "ZZZ-ZZZ")).status).toBe(404);
    expect((await approve(tenants.t, accessToken, "nonsense")).status).toBe(404);
    expect((await approve(tenants.t, token("nobody"))).status).toBe(401);
  });

  test("guessing spends the texter's budget, wrong codes included", async () => {
    const tenants = await twoConnectedTenants();
    const accessToken = await texting(tenants);
    for (let i = 0; i < 10; i += 1) expect((await approve(tenants.t, accessToken, "ZZZ-ZZZ")).status).toBe(404);
    await startPairing(tenants.t);
    expect((await approve(tenants.t, accessToken)).status).toBe(429);
  });
});

describe("a person's own computers", () => {
  test("own computers only: active, never mail-only, never somebody else's", async () => {
    const tenants = await twoConnectedTenants();
    const accessToken = await texting(tenants);
    const pairingId = await startPairing(tenants.t);
    await approve(tenants.t, accessToken);
    const claimed = await bodyOf(await gatewayPost(tenants.t, "/gateway/machines/pair/claim", { pairingId, grant: GRANT }));

    // A mail-only device of alice's, and a computer of bob's.
    await startPairing(tenants.t, "AAA-BBB");
    await gatewayPost(tenants.t, "/gateway/machines/pair/approve-grant", { accessToken: ACCESS_A, workspaceId: tenants.aliceWs, code: "AAA-BBB" });
    const owned = async (userId: string) => (await bodyOf(await gatewayPost(tenants.t, "/gateway/machines/owned", { userId }))).machines;
    expect(await owned(tenants.alice)).toEqual([{ machineId: claimed.machineId, workspaceId: tenants.aliceWs }]);
    expect(await owned(tenants.bob)).toEqual([]);
    expect(await owned("not-an-id")).toEqual([]);

    await tenants.t.run((ctx) => ctx.db.patch(claimed.machineId as Id<"texMachines">, { status: "revoked" }));
    expect(await owned(tenants.alice)).toEqual([]);
  });
});
