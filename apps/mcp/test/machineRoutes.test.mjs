/**
 * The gateway's machine routes: a runner pairs with a code the person
 * approves, collects its grant only by signing with the key it started with,
 * and opens its socket with that grant, after which its workspace object asks
 * for a signed hello (`machineSockets.test.mjs`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MACHINE_PATHS, handleMachines, mintMachineGrant, mintPairingCode } from "../src/machines/routes.js";
import { MACHINE_APP_PATHS } from "../src/machines/appRoutes.js";
import { splitWorkspacePath } from "../src/workspacePath.js";
import { serveMachineCall } from "../src/workspaceStore/serveMachines.js";
import { opOf } from "../src/texStore/move.js";
import { FACTS, keyPair, machineWorld, protocol } from "./machineWorld.mjs";

const ORIGIN = "https://mcp.example.test";

/** A control plane that keeps pairings and machines the way the Convex functions do, hashes aside. */
function fakeControlPlane() {
  const pairings = new Map();
  const machines = new Map();
  let next = 0;
  return {
    pairings,
    machines,
    approve(pairingId, { workspaceId = "ws_a", ownerId = "user_owner" } = {}) {
      Object.assign(pairings.get(pairingId), { status: "approved", workspaceId, ownerId });
    },
    async texMachinePairStart({ code, publicKey, name, os, facts }) {
      if ([...pairings.values()].some((p) => p.code === code)) return { taken: true };
      const pairingId = `pair_${(next += 1)}`;
      pairings.set(pairingId, { code, publicKey, name, os, facts, status: "waiting" });
      return { pairingId, expiresAt: 1 };
    },
    async texMachinePairRead(pairingId) {
      const p = pairings.get(pairingId);
      return p ? { status: p.status, publicKey: p.publicKey, expired: false, name: p.name, os: p.os, facts: p.facts } : null;
    },
    async texMachinePairClaim(pairingId, grant) {
      const p = pairings.get(pairingId);
      if (p?.status !== "approved") return { refused: 409 };
      p.status = "claimed";
      const machineId = `mch_${(next += 1)}`;
      machines.set(grant, { machineId, workspaceId: p.workspaceId, ownerId: p.ownerId, name: p.name, revoked: false });
      return { machineId, workspaceId: p.workspaceId, ownerId: p.ownerId, name: p.name, workspaceHandle: "@seyi" };
    },
    async texMachineResolve(grant) {
      const m = machines.get(grant);
      return m && !m.revoked ? { machineId: m.machineId, workspaceId: m.workspaceId, ownerId: m.ownerId } : null;
    },
    async texMachineRegister({ userId, workspaceId, grant, publicKey, name }) {
      if (userId === "user_member") return { refused: 403 };
      const machineId = `mch_${(next += 1)}`;
      machines.set(grant, { machineId, workspaceId, ownerId: userId, name, publicKey, revoked: false });
      return { machineId, workspaceId, ownerId: userId, name, workspaceHandle: "@seyi" };
    },
    async texMachineRevoke(machineId) {
      for (const m of machines.values()) if (m.machineId === machineId) m.revoked = true;
      return { revoked: true };
    },
  };
}

/** WORKSPACE_STORE over machine worlds, one per workspace id. */
function objects() {
  const worlds = new Map();
  const world = (id) => {
    if (!worlds.has(id)) worlds.set(id, machineWorld({ workspaceId: id }));
    return worlds.get(id);
  };
  const namespace = {
    idFromName: (name) => name,
    get: (name) => ({
      async fetch(request) {
        const w = world(name.replace(/^workspace:/, ""));
        if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") return w.sockets.accept(request);
        return await serveMachineCall({ machines: w.machines, machineSockets: w.sockets }, opOf(request), JSON.parse(await request.text()));
      },
    }),
  };
  return { world, env: { WORKSPACE_STORE: namespace } };
}

const post = (path, body, headers = {}) => new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const route = (request, env, deps) => handleMachines(request, env, { path: new URL(request.url).pathname, origin: ORIGIN }, deps);

async function pair(controlPlane, env, keys) {
  const started = await (await route(post("/machines/pair", { publicKey: keys.publicKey, name: "tex-devs-vm", facts: FACTS }), env, { controlPlane })).json();
  return started;
}

test("codes and grants have the shape the protocol and the control plane expect", () => {
  for (let i = 0; i < 200; i += 1) assert.match(mintPairingCode(), /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
  assert.match(mintMachineGrant(), /^cmg_[0-9a-f]{64}$/);
  assert.notEqual(mintMachineGrant(), mintMachineGrant());
});

test("a runner pairs, the person approves, the runner collects its grant and connects", async () => {
  const controlPlane = fakeControlPlane();
  const { env, world } = objects();
  const keys = await keyPair();
  const started = await pair(controlPlane, env, keys);
  assert.equal(protocol.invalid("PairStarted", started), null);
  assert.ok(started.approveUrl.includes(encodeURIComponent(started.code)));
  const poll = async () => await (await route(post("/machines/pair/poll", { pairingId: started.pairingId, signature: await keys.sign(protocol.pairSigningText(started.pairingId)) }), env, { controlPlane })).json();
  assert.deepEqual(await poll(), { status: "waiting" });
  controlPlane.approve(started.pairingId);
  const approved = await poll();
  assert.equal(protocol.invalid("PairStatus", approved), null);
  assert.equal(approved.status, "approved");
  assert.equal(approved.socketUrl, "wss://mcp.example.test/machines/socket");
  // The grant is returned once: the pairing is spent.
  assert.deepEqual(await poll(), { status: "expired" });
  // The object holds the machine with the key the pairing started with.
  const held = world("ws_a").machines.get(approved.machineId);
  assert.equal(held.publicKey, keys.publicKey);
  assert.equal(held.ownerId, "user_owner");
  // The socket opens with the grant and asks for a signed hello.
  const upgrade = new Request(`${ORIGIN}/machines/socket`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${approved.grant}` } });
  const response = await route(upgrade, env, { controlPlane });
  assert.equal(response.status, 101);
  const server = world("ws_a").accepted.at(-1);
  assert.equal(server.sent[0].type, "challenge");
});

test("only the machine that asked can collect the grant", async () => {
  const controlPlane = fakeControlPlane();
  const { env } = objects();
  const keys = await keyPair();
  const thief = await keyPair();
  const started = await pair(controlPlane, env, keys);
  controlPlane.approve(started.pairingId);
  const stolen = await route(post("/machines/pair/poll", { pairingId: started.pairingId, signature: await thief.sign(protocol.pairSigningText(started.pairingId)) }), env, { controlPlane });
  assert.equal(stolen.status, 404);
  // A hello signature for the same id is not a pairing signature.
  const wrongPurpose = await route(post("/machines/pair/poll", { pairingId: started.pairingId, signature: await keys.sign(protocol.helloSigningText(started.pairingId, "x")) }), env, { controlPlane });
  assert.equal(wrongPurpose.status, 404);
  assert.equal(controlPlane.pairings.get(started.pairingId).status, "approved", "nothing was claimed");
  assert.equal(controlPlane.machines.size, 0);
});

test("a socket without a valid, unrevoked grant is refused before the object", async () => {
  const controlPlane = fakeControlPlane();
  const { env, world } = objects();
  const keys = await keyPair();
  const started = await pair(controlPlane, env, keys);
  controlPlane.approve(started.pairingId);
  const approved = await (await route(post("/machines/pair/poll", { pairingId: started.pairingId, signature: await keys.sign(protocol.pairSigningText(started.pairingId)) }), env, { controlPlane })).json();
  const open = (authorization) => route(new Request(`${ORIGIN}/machines/socket`, { headers: { Upgrade: "websocket", ...(authorization ? { Authorization: authorization } : {}) } }), env, { controlPlane });
  assert.equal((await open(null)).status, 401);
  assert.equal((await open(`Bearer ${mintMachineGrant()}`)).status, 401);
  assert.equal((await open(`Bearer cat_${"0".repeat(64)}`)).status, 401, "an AI client's token is not a machine grant");
  for (const m of controlPlane.machines.values()) m.revoked = true;
  assert.equal((await open(`Bearer ${approved.grant}`)).status, 401);
  assert.equal(world("ws_a").accepted.length, 0);
});

test("malformed pairing requests are refused without reaching the control plane", async () => {
  const controlPlane = fakeControlPlane();
  const { env } = objects();
  assert.equal((await route(post("/machines/pair", { publicKey: "short", name: "x", facts: FACTS }), env, { controlPlane })).status, 400);
  assert.equal((await route(post("/machines/pair", { publicKey: "A".repeat(43), name: "x", facts: FACTS, extra: 1 }), env, { controlPlane })).status, 400);
  assert.equal((await route(post("/machines/pair/poll", { pairingId: "p", signature: "x" }), env, { controlPlane })).status, 400);
  assert.equal(controlPlane.pairings.size, 0);
  assert.equal((await route(new Request(`${ORIGIN}/machines/pair`), env, { controlPlane })).status, 405);
});

test("a machine the object never took is revoked, and the runner pairs again", async () => {
  const controlPlane = fakeControlPlane();
  const keys = await keyPair();
  const env = { WORKSPACE_STORE: { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({ ok: false, code: "not_served" }) }) } };
  const started = await pair(controlPlane, env, keys);
  controlPlane.approve(started.pairingId);
  const answer = await route(post("/machines/pair/poll", { pairingId: started.pairingId, signature: await keys.sign(protocol.pairSigningText(started.pairingId)) }), env, { controlPlane });
  assert.equal(answer.status, 503);
  assert.ok([...controlPlane.machines.values()].every((m) => m.revoked));
});

test("the signed-in Mac app registers its own Mac with its session, and gets a grant of its own", async () => {
  const controlPlane = fakeControlPlane();
  const { env, world } = objects();
  const keys = await keyPair();
  const session = (fields) => async () => ({ workspaceId: "ws_a", actorUserId: "user_owner", scopes: ["context:read", "context:write"], scope: "private", ...fields });
  const register = (resolveSession) => route(post("/machines/register", { publicKey: keys.publicKey, name: "MacBook Pro", facts: { ...FACTS, os: "macos" } }, { Authorization: "Bearer cat_x" }), env, { controlPlane, resolveSession });
  const answer = await (await register(session({}))).json();
  assert.match(answer.grant, /^cmg_[0-9a-f]{64}$/);
  assert.equal(world("ws_a").machines.get(answer.machineId).publicKey, keys.publicKey);
  assert.equal((await register(session({ scopes: ["context:read"] }))).status, 403, "a read-only connection cannot add a machine");
  assert.equal((await register(session({ actorUserId: "user_member" }))).status, 403, "the control plane's role rule holds");
  const { SessionRefusal } = await import("../src/session.js");
  assert.equal((await register(async () => { throw new SessionRefusal(401, "no"); })).status, 401);
});

// Production answered `POST /machines/pair` with 404 while every test here was
// green: the handler was right, but the gateway read `/machines/pair` as "the
// workspace called machines, at /pair", the defect `meetings`, `agent` and
// `approvals` each record in RESERVED_FIRST_SEGMENTS. Sabotage: drop
// `machines` from that list and this fails.
test("every machine route is a route, never a workspace called machines", () => {
  for (const path of [...MACHINE_PATHS, ...MACHINE_APP_PATHS]) {
    assert.deepEqual(splitWorkspacePath(path), { slug: null, path }, path);
    assert.deepEqual(splitWorkspacePath(`/@seyi${path}`), { slug: "seyi", path }, `/@seyi${path}`);
  }
});
