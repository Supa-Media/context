/**
 * Installing a coding tool on a computer from the app (`machines/appRoutes.js`
 * `/machines/app/install`, `serveMachines.js` `install`, the runner's
 * `install.rs`), and Codex's device sign-in (`signInState` with `userCode`):
 * only the computer's own owner installs, the frame names a tool and nothing
 * to run, one install runs at a time, and Codex's one-time code reaches only
 * the owner and is never pasted back.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `install` using `runnable` instead of `ownComputer` → "only the computer's own owner installs a tool on it".
 *  2. the `busy` check dropped → "one install at a time, and a stale one doesn't block the next".
 *  3. `list` keeping `userCode` for a workspace owner → "Codex's one-time code shows only to the computer's own owner".
 *  4. the `!held.userCode` check dropped → "a device sign-in takes no pasted code".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { handleMachineApp } from "../src/machines/appRoutes.js";
import { INSTALL_WAIT_MS, serveMachineCall } from "../src/workspaceStore/serveMachines.js";
import { opOf } from "../src/texStore/move.js";
import { FACTS, machineWorld } from "./machineWorld.mjs";

const ORIGIN = "https://mcp.example.test";
const app = (userId, role) => ({ actorClientId: "context_console", actorUserId: userId, scopes: ["context:read", "context:write"], workspaceId: "ws_team", workspaces: [{ workspaceId: "ws_team", slug: "devs", role, kind: "shared" }] });
const owner = app("user_owner", "editor");
const boss = app("user_boss", "owner");

async function setup({ facts = { ...FACTS, signIn: ["claude", "codex"], install: ["claude", "codex"] }, clock } = {}) {
  const w = machineWorld({ workspaceId: "ws_team", ...(clock ? { clock } : {}) });
  const namespace = {
    idFromName: (name) => name,
    get: () => ({ fetch: async (request) => await serveMachineCall({ machines: w.machines, machineSockets: w.sockets }, opOf(request), JSON.parse(await request.text())) }),
  };
  const machine = await w.add("mch_1");
  const server = await w.connect(machine, { hello: { facts } });
  const route = async (path, body, who = owner) => {
    const response = await handleMachineApp(new Request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify({ workspaceId: "ws_team", machineId: "mch_1", ...body }) }), { WORKSPACE_STORE: namespace }, who, { path, controlPlane: {} });
    return await response.json();
  };
  const list = async (who) => (await route("/machines/app/list", {}, who)).machines[0];
  return { w, server, install: (body, who) => route("/machines/app/install", body, who), signIn: (body, who) => route("/machines/app/sign-in", body, who), list };
}

test("its owner installs a tool: the frame names the tool, and the runner's progress shows on the computer", async () => {
  const { w, server, install, list } = await setup();
  const answer = await install({ tool: "codex" });
  assert.equal(answer.ok, true);
  const frame = server.last();
  assert.deepEqual(Object.keys(frame).sort(), ["installId", "tool", "type"], "nothing in the frame says what to run or fetch");
  assert.equal(frame.type, "install");
  assert.match(frame.installId, /^in_[0-9a-f]{24}$/);
  assert.equal((await list(owner)).install.state, "starting");
  await w.frame(server, { type: "installState", installId: frame.installId, tool: "codex", state: "working", step: "downloading", percent: 40 });
  const working = (await list(owner)).install;
  assert.equal(working.state, "working");
  assert.equal(working.step, "downloading");
  assert.equal(working.percent, 40);
  await w.frame(server, { type: "installState", installId: frame.installId, tool: "codex", state: "done", version: "0.166.0" });
  const done = (await list(owner)).install;
  assert.equal(done.state, "done");
  assert.equal(done.version, "0.166.0");
  // An ended install doesn't move again, and an unknown id changes nothing.
  await w.frame(server, { type: "installState", installId: frame.installId, tool: "codex", state: "failed", error: "late" });
  await w.frame(server, { type: "installState", installId: "in_000000000000000000000000", tool: "codex", state: "working" });
  assert.equal((await list(owner)).install.state, "done");
});

test("only the computer's own owner installs a tool on it", async () => {
  const { server, install } = await setup();
  const before = server.sent.length;
  assert.deepEqual(await install({ tool: "codex" }, boss), { ok: false, code: "unknown_machine" });
  assert.deepEqual(await install({ tool: "codex" }, app("user_editor", "editor")), { ok: false, code: "unknown_machine" });
  assert.equal(server.sent.length, before);
});

test("an unknown tool, or a runner that can't install, is refused", async () => {
  const { install } = await setup();
  assert.notEqual((await install({ tool: "gh" })).ok, true);
  const old = await setup({ facts: FACTS });
  assert.deepEqual(await old.install({ tool: "codex" }), { ok: false, code: "not_supported" });
});

test("one install at a time, and a stale one doesn't block the next", async () => {
  const clock = { at: 1_800_000_000_000 };
  const { server, install } = await setup({ clock });
  assert.equal((await install({ tool: "codex" })).ok, true);
  const sent = server.sent.length;
  assert.deepEqual(await install({ tool: "claude" }), { ok: false, code: "busy" });
  assert.equal(server.sent.length, sent);
  clock.at += INSTALL_WAIT_MS + 1;
  assert.equal((await install({ tool: "claude" })).ok, true);
});

test("Codex's one-time code shows only to the computer's own owner", async () => {
  const { w, server, signIn, list } = await setup();
  assert.equal((await signIn({ tool: "codex" })).ok, true);
  const frame = server.last();
  await w.frame(server, { type: "signInState", signInId: frame.signInId, tool: "codex", state: "link", url: "https://auth.openai.com/codex/device", userCode: "7K2Q-M9XFD" });
  const mine = (await list(owner)).signIn;
  assert.equal(mine.userCode, "7K2Q-M9XFD");
  assert.equal(mine.url, "https://auth.openai.com/codex/device");
  const theirs = (await list(boss)).signIn;
  assert.equal(theirs.userCode, undefined);
  assert.equal(theirs.url, undefined);
});

test("a device sign-in takes no pasted code", async () => {
  const { w, server, signIn } = await setup();
  await signIn({ tool: "codex" });
  const frame = server.last();
  await w.frame(server, { type: "signInState", signInId: frame.signInId, tool: "codex", state: "link", url: "https://auth.openai.com/codex/device", userCode: "7K2Q-M9XFD" });
  const sent = server.sent.length;
  assert.deepEqual(await signIn({ signInId: frame.signInId, code: "anything" }), { ok: false, code: "sign_in_ended" });
  assert.equal(server.sent.length, sent);
});
