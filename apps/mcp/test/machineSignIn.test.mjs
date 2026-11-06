/**
 * Signing a coding tool in on a computer from the app (`machines/appRoutes.js`
 * `/machines/app/sign-in`, `serveMachines.js` `signIn`, the runner's
 * `sign_in.rs`): only the computer's own owner starts one, the runner's link
 * reaches only them, and the code they paste goes to the runner and is kept
 * nowhere on the way.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `signIn` using `runnable` instead of `ownComputer` → "only the computer's own owner signs a tool in on it".
 *  2. `signIn` saving `code` on the row and `signInOf` keeping every field → "the code reaches the runner and is kept nowhere".
 *  3. the `held.id === fields.signInId` check dropped → "a code for a sign-in that ended, or ran out of time, is refused".
 *  4. `list` keeping the link for a workspace owner → "only the computer's own owner sees the sign-in link".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { handleMachineApp } from "../src/machines/appRoutes.js";
import { serveMachineCall, SIGN_IN_WAIT_MS } from "../src/workspaceStore/serveMachines.js";
import { opOf } from "../src/texStore/move.js";
import { FACTS, machineWorld } from "./machineWorld.mjs";

const ORIGIN = "https://mcp.example.test";
const LINK = "https://claude.com/cai/oauth/authorize?code=true&state=fake";
const CODE = "fakeCode123#fakeState456";

const app = (userId, role) => ({ actorClientId: "context_console", actorUserId: userId, scopes: ["context:read", "context:write"], workspaceId: "ws_team", workspaces: [{ workspaceId: "ws_team", slug: "devs", role, kind: "shared" }] });
const owner = app("user_owner", "editor");
const boss = app("user_boss", "owner");

async function setup({ facts = { ...FACTS, signIn: ["claude"] }, online = true } = {}) {
  const w = machineWorld({ workspaceId: "ws_team" });
  const namespace = {
    idFromName: (name) => name,
    get: () => ({ fetch: async (request) => await serveMachineCall({ machines: w.machines, machineSockets: w.sockets }, opOf(request), JSON.parse(await request.text())) }),
  };
  const machine = await w.add("mch_1");
  const server = online ? await w.connect(machine, { hello: { facts } }) : null;
  const ask = async (body, who = owner) => {
    const path = "/machines/app/sign-in";
    const response = await handleMachineApp(new Request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify({ workspaceId: "ws_team", machineId: "mch_1", ...body }) }), { WORKSPACE_STORE: namespace }, who, { path, controlPlane: {} });
    return await response.json();
  };
  const list = async (who) => {
    const path = "/machines/app/list";
    const response = await handleMachineApp(new Request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify({ workspaceId: "ws_team" }) }), { WORKSPACE_STORE: namespace }, who, { path, controlPlane: {} });
    return (await response.json()).machines[0];
  };
  return { w, server, ask, list };
}

async function started() {
  const world = await setup();
  const answer = await world.ask({ tool: "claude" });
  assert.equal(answer.ok, true);
  const frame = world.server.last();
  await world.w.frame(world.server, { type: "signInState", signInId: frame.signInId, tool: "claude", state: "link", url: LINK });
  return { ...world, signInId: frame.signInId, frame };
}

test("its owner starts a sign-in, and the runner's link shows on the computer", async () => {
  const { w, frame, signInId, list } = await started();
  assert.deepEqual(frame, { type: "signIn", signInId, tool: "claude" });
  assert.match(signInId, /^si_[0-9a-f]{24}$/);
  const seen = await list(owner);
  assert.equal(seen.signIn.state, "link");
  assert.equal(seen.signIn.url, LINK);
  assert.equal(w.machines.get("mch_1").signIn.tool, "claude");
});

test("only the computer's own owner signs a tool in on it", async () => {
  const { ask, server } = await setup();
  const before = server.sent.length;
  // The workspace's owner runs the computer, but it is not their account to sign in on it.
  assert.deepEqual(await ask({ tool: "claude" }, boss), { ok: false, code: "unknown_machine" });
  assert.deepEqual(await ask({ tool: "claude" }, app("user_editor", "editor")), { ok: false, code: "unknown_machine" });
  assert.equal(server.sent.length, before);
});

test("only the computer's own owner sees the sign-in link", async () => {
  const { list } = await started();
  const seen = await list(boss);
  assert.equal(seen.signIn.state, "link");
  assert.equal(seen.signIn.url, undefined);
});

test("the code reaches the runner and is kept nowhere", async () => {
  const { w, server, ask, list, signInId } = await started();
  const answer = await ask({ signInId, code: ` ${CODE} ` });
  assert.equal(answer.ok, true);
  assert.deepEqual(server.last(), { type: "signIn", signInId, tool: "claude", code: CODE });
  assert.equal(JSON.stringify(answer).includes(CODE), false);
  assert.equal(JSON.stringify(w.machines.get("mch_1")).includes(CODE), false);
  assert.equal(JSON.stringify(await list(owner)).includes(CODE), false);
  assert.equal(w.machines.get("mch_1").signIn.state, "checking");
  await w.frame(server, { type: "signInState", signInId, tool: "claude", state: "done" });
  assert.equal(w.machines.get("mch_1").signIn.state, "done");
  // A sign-in that ended takes no more news.
  await w.frame(server, { type: "signInState", signInId, tool: "claude", state: "failed", error: "late" });
  assert.equal(w.machines.get("mch_1").signIn.state, "done");
});

test("a code for a sign-in that ended, or ran out of time, is refused", async () => {
  const { w, server, ask, signInId } = await started();
  const before = server.sent.length;
  assert.deepEqual(await ask({ signInId: `si_${"0".repeat(24)}`, code: CODE }), { ok: false, code: "sign_in_ended" });
  w.clock.at += SIGN_IN_WAIT_MS + 1;
  assert.deepEqual(await ask({ signInId, code: CODE }), { ok: false, code: "sign_in_ended" });
  assert.equal(server.sent.length, before);
});

test("a code that isn't one line of plain characters is refused without being repeated back", async () => {
  const { server, ask, signInId } = await started();
  const before = server.sent.length;
  const bad = "two words";
  const answer = await ask({ signInId, code: bad });
  assert.deepEqual(answer, { ok: false, code: "bad_code" });
  assert.equal(server.sent.length, before);
});

test("news of another sign-in changes nothing", async () => {
  const { w, server } = await started();
  await w.frame(server, { type: "signInState", signInId: `si_${"1".repeat(24)}`, tool: "claude", state: "done" });
  assert.equal(w.machines.get("mch_1").signIn.state, "link");
});

test("a runner that can't sign in from the app, or a computer that's offline, is said so", async () => {
  assert.deepEqual(await (await setup({ facts: FACTS })).ask({ tool: "claude" }), { ok: false, code: "not_supported" });
  const offline = await setup();
  offline.w.sockets.goodbye("mch_1");
  assert.deepEqual(await offline.ask({ tool: "claude" }), { ok: false, code: "offline" });
  assert.equal((await (await setup()).ask({ tool: "codex" })).code, "not_supported");
});
