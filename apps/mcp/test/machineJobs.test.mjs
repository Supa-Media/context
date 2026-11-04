/**
 * A job's part on a person's own computer, as the texting Worker's job object
 * asks for it (`machines/jobRoutes.js`): it gets a run grant that acts as the
 * job's own grant but can never send, the workspace object checks the
 * machine's rules, and only the person whose job it is can read, steer or
 * stop the run.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { handleMachineJob } from "../src/machines/jobRoutes.js";
import { serveMachineCall } from "../src/workspaceStore/serveMachines.js";
import { opOf } from "../src/texStore/move.js";
import { MACHINE_RUN_CLIENT_ID, MACHINE_RUN_REFUSED_TOOLS, machineRunRefuses } from "../src/tools/machineRun.js";
import { toolsForSession } from "../src/tools/advertised.js";
import { callToolForSession } from "../src/tools/session.js";
import { machineWorld } from "./machineWorld.mjs";

const ORIGIN = "https://mcp.example.test";

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
        return await serveMachineCall({ machines: w.machines, machineSockets: w.sockets }, opOf(request), JSON.parse(await request.text()));
      },
    }),
  };
  return { world, env: { WORKSPACE_STORE: namespace } };
}

function fakeControlPlane() {
  const grants = new Map();
  return {
    grants,
    refuse: false,
    async texMachineRunGrant({ parentToken, machineId, runId, expiresAt }) {
      if (this.refuse) return null;
      const accessToken = `cat_run_${grants.size + 1}_000000000000`;
      grants.set(runId, { parentToken, machineId, accessToken, expiresAt, revoked: false });
      return { accessToken, expiresAt };
    },
    async texMachineRunRevoke(runId) {
      const grant = grants.get(runId);
      if (grant) grant.revoked = true;
      return { revoked: grant ? 1 : 0 };
    },
  };
}

const session = (fields = {}) => {
  const s = { actorClientId: "context_texts", actorUserId: "user_owner", scopes: ["context:read", "context:write", "context:private"], workspaceId: "ws_a", workspaces: [{ workspaceId: "ws_a", slug: "seyi", role: "owner", kind: "personal" }], ...fields };
  Object.defineProperty(s, "accessToken", { value: "cat_parent_token_000000", enumerable: false });
  return s;
};

async function setup() {
  const { world, env } = objects();
  const w = world("ws_a");
  const machine = await w.add("mch_1");
  const server = await w.connect(machine);
  const controlPlane = fakeControlPlane();
  const ask = async (path, body, who = session()) => {
    const response = await handleMachineJob(new Request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) }), env, who, { path, controlPlane, origin: ORIGIN, now: () => w.clock.at });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const assignBody = (fields = {}) => ({ workspaceId: "ws_a", machineId: "mch_1", jobId: "job_1", part: 1, tool: "claude", folder: "/srv/code", permission: "edits", brief: "Fix the flaky test.", doneWhen: "It passes.", ...fields });
  return { w, server, controlPlane, ask, assignBody };
}

test("the owner's own job gets a run grant for its part, bound to the job's grant, and the runner is sent it", async () => {
  const { w, server, controlPlane, ask, assignBody } = await setup();
  const { body } = await ask("/agent/machine/assign", assignBody());
  assert.equal(body.ok, true);
  const frame = server.last();
  assert.equal(frame.type, "assign");
  assert.equal(frame.runId, body.runId);
  assert.equal(frame.fromOwner, true);
  const grant = controlPlane.grants.get(body.runId);
  // Minted from the job's own token: the run acts as the job, never as anyone the body names.
  assert.equal(grant.parentToken, "cat_parent_token_000000");
  assert.equal(frame.grant.token, grant.accessToken);
  assert.equal(frame.grant.mcpUrl, `${ORIGIN}/mcp`);
  assert.ok(frame.deadline <= w.clock.at + 30 * 60 * 1000);
});

test("who asked comes from the grant, never the body", async () => {
  const { server, ask, assignBody } = await setup();
  const { body } = await ask("/agent/machine/assign", assignBody({ fromOwner: true, askerId: "user_owner", chat: "anything" }), session({ actorUserId: "user_other", workspaces: [{ workspaceId: "ws_a", slug: "seyi", role: "editor", kind: "shared" }] }));
  // Somebody else's ask on the owner's machine is refused by the owner's rules: no chat allows them.
  assert.deepEqual(body, { ok: false, code: "rule" });
  assert.notEqual(server.last().type, "assign");
});

test("an owner's rule for one person's own chat lets that person in, and covers nobody else's", async () => {
  const { w, server, ask, assignBody } = await setup();
  await w.call("ws.machine.set", { id: "mch_1", patch: { chats: { "texts-user_ade": { who: "everyone", askFirst: false } } } });
  const member = (id) => session({ actorUserId: id, workspaces: [{ workspaceId: "ws_a", slug: "devs", role: "editor", kind: "shared" }] });
  const ade = await ask("/agent/machine/assign", assignBody(), member("user_ade"));
  assert.equal(ade.body.ok, true);
  assert.equal(server.last().fromOwner, false);
  // Not the owner's: no computer use, and no full permissions, whatever was asked.
  assert.equal(server.last().computerUse, false);
  const bola = await ask("/agent/machine/assign", assignBody(), member("user_bola"));
  assert.deepEqual(bola.body, { ok: false, code: "rule" });
});

test("a refused assignment takes its run grant back at once", async () => {
  const { controlPlane, ask, assignBody } = await setup();
  const { body } = await ask("/agent/machine/assign", assignBody({ folder: "/etc" }));
  assert.deepEqual(body, { ok: false, code: "folder" });
  const [grant] = controlPlane.grants.values();
  assert.equal(grant.revoked, true);
});

test("no run grant, no assignment", async () => {
  const { server, controlPlane, ask, assignBody } = await setup();
  controlPlane.refuse = true;
  const { body } = await ask("/agent/machine/assign", assignBody());
  assert.deepEqual(body, { ok: false, code: "grant" });
  assert.notEqual(server.last().type, "assign");
});

test("a workspace the job's grant does not reach is no machine at all", async () => {
  const { ask, assignBody } = await setup();
  const { body } = await ask("/agent/machine/assign", assignBody({ workspaceId: "ws_b" }));
  assert.deepEqual(body, { ok: false, code: "unknown_machine" });
});

test("only a person's own texting client with write scope reaches these routes", async () => {
  const { ask, assignBody } = await setup();
  for (const who of [session({ actorClientId: "context_texts_group" }), session({ actorClientId: "some_ai_client" }), session({ actorClientId: MACHINE_RUN_CLIENT_ID }), session({ scopes: ["context:read"] })]) {
    const { status } = await ask("/agent/machine/assign", assignBody(), who);
    assert.equal(status, 403);
  }
});

test("only the person whose job it is reads, steers or stops a run; an ended run's grant goes", async () => {
  const { w, server, controlPlane, ask, assignBody } = await setup();
  const { body } = await ask("/agent/machine/assign", assignBody());
  const runId = body.runId;
  const stranger = session({ actorUserId: "user_other", workspaces: [{ workspaceId: "ws_a", slug: "seyi", role: "editor", kind: "shared" }] });
  assert.deepEqual((await ask("/agent/machine/run", { workspaceId: "ws_a", runId }, stranger)).body, { ok: false, code: "unknown_run" });
  assert.deepEqual((await ask("/agent/machine/cancel", { workspaceId: "ws_a", runId }, stranger)).body, { ok: false, code: "unknown_run" });
  assert.deepEqual((await ask("/agent/machine/deliver", { workspaceId: "ws_a", runId, messageId: "msg_1", text: "make it yellow" }, stranger)).body, { ok: false, code: "unknown_run" });

  await w.frame(server, { type: "accept", runId });
  await w.frame(server, { type: "step", runId, seq: 1, tool: "Edit", target: "src/a.ts", at: w.clock.at });
  const delivered = await ask("/agent/machine/deliver", { workspaceId: "ws_a", runId, messageId: "msg_1", text: "make it yellow" });
  assert.equal(delivered.body.ok, true);
  assert.deepEqual({ type: server.last().type, text: server.last().text }, { type: "message", text: "make it yellow" });
  await ask("/agent/machine/deliver", { workspaceId: "ws_a", runId, messageId: "msg_2", text: "stop and read this", interrupt: true });
  assert.equal(server.last().type, "interrupt");

  let read = (await ask("/agent/machine/run", { workspaceId: "ws_a", runId })).body;
  assert.equal(read.run.state, "running");
  assert.equal(read.run.steps.length, 1);
  assert.equal(controlPlane.grants.get(runId).revoked, false);

  await w.frame(server, { type: "result", runId, outcome: "finished", answer: "Fixed.", session: "sess_1", wallMs: 1000 });
  read = (await ask("/agent/machine/run", { workspaceId: "ws_a", runId })).body;
  assert.equal(read.run.state, "ended");
  assert.equal(read.run.result.answer, "Fixed.");
  assert.equal(read.run.session, "sess_1");
  assert.equal(controlPlane.grants.get(runId).revoked, true);
});

test("stopping a run cancels it on the machine and takes its grant back", async () => {
  const { server, controlPlane, ask, assignBody } = await setup();
  const { body } = await ask("/agent/machine/assign", assignBody());
  const stopped = await ask("/agent/machine/cancel", { workspaceId: "ws_a", runId: body.runId });
  assert.equal(stopped.body.ok, true);
  assert.deepEqual({ type: server.last().type, reason: server.last().reason }, { type: "cancel", reason: "stopped" });
  assert.equal(controlPlane.grants.get(body.runId).revoked, true);
});

test("a run grant's session is never offered, and never runs, a call that reaches outside", async () => {
  const run = session({ actorClientId: MACHINE_RUN_CLIENT_ID });
  for (const name of ["send", "send_email", "notify_me", "slack_api", "google_chat", "calendar_event", "app_change", "create_link", "invite_member", "vault_list"]) {
    assert.ok(MACHINE_RUN_REFUSED_TOOLS.has(name), name);
    assert.equal(machineRunRefuses(run, name), true, name);
  }
  // The texting client itself is not narrowed by this.
  assert.equal(machineRunRefuses(session(), "send_email"), false);
  const store = { getSettings: async () => null, readFile: async () => null, get: async () => null };
  const offered = (await toolsForSession(run, store).catch(() => [])).map((tool) => tool.name);
  assert.ok(!offered.includes("send"));
  const refused = await callToolForSession({ name: "send", arguments: { action: "email", args: { to: "a@example.test", subject: "x", body: "y" } } }, store, run);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /can't send/);
});
