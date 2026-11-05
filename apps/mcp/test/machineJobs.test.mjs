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
  return { world, env: { WORKSPACE_STORE: namespace, AI: { run: async () => ({}) }, APP_ORIGIN: "https://app.example.test" } };
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
    usage: [],
    lent: [],
    async texMachinesForChat(groupKey) {
      return this.lent.filter((entry) => entry.groupKey === groupKey).map(({ machineId, workspaceId, ownerId }) => ({ machineId, workspaceId, ownerId }));
    },
    async recordBuiltinUsage(accessToken, workspaceId, usage) {
      this.usage.push({ accessToken, workspaceId, ...usage });
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
  const advisor = { asked: [], reply: { text: "VERDICT: keep_going\nADVICE: Run the test ten times and show it passing.", usage: { input: 50, output: 9 } } };
  const advise = async (params) => {
    advisor.asked.push(params);
    if (advisor.reply === null) throw new Error("unreachable");
    return advisor.reply;
  };
  const ask = async (path, body, who = session(), store = { contexts: [] }) => {
    const response = await handleMachineJob(new Request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) }), env, who, { path, controlPlane, origin: ORIGIN, store, now: () => w.clock.at, advise });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const assignBody = (fields = {}) => ({ workspaceId: "ws_a", machineId: "mch_1", jobId: "job_1", part: 1, tool: "claude", folder: "/srv/code", permission: "edits", brief: "Fix the flaky test.", doneWhen: "It passes.", ...fields });
  return { w, server, controlPlane, ask, assignBody, advisor };
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

test("a job naming no folder of the owner's goes to the computer's own work folder, by its word", async () => {
  const { server, ask, assignBody } = await setup();
  const { body } = await ask("/agent/machine/assign", assignBody({ folder: "@work" }));
  assert.equal(body.ok, true);
  assert.equal(server.last().type, "assign");
  assert.equal(server.last().folder, "@work");
  // The word only: a path made to look like it is still outside the owner's folders.
  const dotted = await ask("/agent/machine/assign", assignBody({ folder: "@work/../etc" }));
  assert.deepEqual(dotted.body, { ok: false, code: "folder" });
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

test("a part's steps on the computer reach the chat's record as the job's tool calls, each once", async () => {
  const { w, server, ask, assignBody } = await setup();
  const appended = [];
  const store = { contexts: [], texLedger: () => ({ append: async (chat, entries) => void appended.push(...entries.map((e) => ({ chat, ...e }))) }) };
  const me = session({ workspaceKind: "personal" });
  const read = async () => (await ask("/agent/machine/run", { workspaceId: "ws_a", runId }, me, store)).body;
  const { body } = await ask("/agent/machine/assign", assignBody(), me);
  const runId = body.runId;
  await w.frame(server, { type: "accept", runId });
  await w.frame(server, { type: "step", runId, seq: 1, tool: "Bash", action: "git status", at: w.clock.at });
  await w.frame(server, { type: "step", runId, seq: 2, tool: "Edit", target: "src/a.ts", at: w.clock.at });
  await read();
  await read();
  // Read twice, written once: the id is the run's and the step's.
  assert.equal(appended.length, 2 * 2);
  const ids = new Set(appended.map((e) => e.id));
  assert.equal(ids.size, 2);
  const edit = appended.find((e) => e.name === "Edit");
  assert.deepEqual({ chat: edit.chat, kind: edit.kind, args: edit.args, jobId: edit.jobId, computer: edit.computer, ok: edit.ok }, { chat: "texts", kind: "tool", args: { target: "src/a.ts" }, jobId: "job_1", computer: "mch_1", ok: undefined });
  // Another person's read writes nothing to anyone's record.
  const before = appended.length;
  await ask("/agent/machine/run", { workspaceId: "ws_a", runId }, session({ actorUserId: "user_stranger", workspaceKind: "personal" }), store);
  assert.equal(appended.length, before);
});

test("what the tool said and thought, and how the part ended, reach the chat's record naming the computer", async () => {
  const { w, server, ask, assignBody } = await setup();
  const appended = [];
  const store = { contexts: [], texLedger: () => ({ append: async (chat, entries) => void appended.push(...entries.map((e) => ({ chat, ...e }))) }) };
  const me = session({ workspaceKind: "personal" });
  const read = async () => (await ask("/agent/machine/run", { workspaceId: "ws_a", runId }, me, store)).body;
  const { body } = await ask("/agent/machine/assign", assignBody(), me);
  const runId = body.runId;
  await w.frame(server, { type: "accept", runId });
  await w.frame(server, { type: "said", runId, seq: 1, kind: "thinking", text: "Check gh first.", at: w.clock.at });
  await w.frame(server, { type: "step", runId, seq: 2, tool: "Bash", action: "run", target: "gh", at: w.clock.at });
  await w.frame(server, { type: "said", runId, seq: 3, kind: "text", text: "gh needs a browser sign-in.", at: w.clock.at });
  // A resend after a reconnect is recognised by its number and kept once.
  await w.frame(server, { type: "said", runId, seq: 3, kind: "text", text: "gh needs a browser sign-in.", at: w.clock.at });
  await w.frame(server, { type: "result", runId, outcome: "failed", error: "notSignedIn", wallMs: 2000 });
  const answer = await read();
  assert.equal(answer.run.said, undefined, "the job's read itself carries no words: they go to the record");
  const byId = new Map(appended.map((e) => [e.id, e]));
  const thinking = appended.find((e) => e.kind === "thinking");
  const said = appended.filter((e) => e.kind === "said");
  const end = appended.find((e) => e.name === "computer_part");
  assert.equal(thinking.text, "Check gh first.");
  assert.equal(said.length, 1);
  assert.equal(said[0].text, "gh needs a browser sign-in.");
  assert.deepEqual(end.args, { outcome: "failed", error: "notSignedIn" });
  assert.equal(end.ok, false);
  for (const e of byId.values()) {
    assert.equal(e.computer, "mch_1");
    assert.equal(typeof e.computerName, "string");
    assert.ok(e.computerName.length > 0);
    assert.equal(e.jobId, "job_1");
  }
  assert.equal(byId.size, 4, "thinking, step, words and the end, each once");
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

const JOB = { title: "Fix the flaky test", brief: "Find why the upload test flakes and fix it.", doneWhen: "It passes ten times in a row.", attempt: 1, followUps: ["also the retry test"] };

test("an ended part is checked by the advisor against the finish line, on what the run itself did", async () => {
  const { w, server, controlPlane, ask, assignBody, advisor } = await setup();
  const { body } = await ask("/agent/machine/assign", assignBody());
  const runId = body.runId;
  await w.frame(server, { type: "accept", runId });
  await w.frame(server, { type: "step", runId, seq: 1, tool: "Bash", action: "run", target: "pnpm test upload", at: w.clock.at });
  // Not ended yet: nothing to check.
  assert.deepEqual((await ask("/agent/machine/check", { workspaceId: "ws_a", runId, job: JOB })).body, { ok: false, code: "not_ended" });
  await w.frame(server, { type: "result", runId, outcome: "finished", answer: "I'll run it ten times next.", session: "sess_1", wallMs: 1000 });
  // The body's own steps and answer are never read: the run's are.
  const checked = await ask("/agent/machine/check", { workspaceId: "ws_a", runId, job: JOB, answer: "All done, ten passes.", steps: [] });
  assert.deepEqual(checked.body, { ok: true, verdict: "keep_going", advice: "Run the test ten times and show it passing.", unfinished: true, untrusted: true });
  const brief = advisor.asked[0].messages[0].text;
  assert.match(brief, /pnpm test upload/);
  assert.match(brief, /I'll run it ten times next\./);
  assert.doesNotMatch(brief, /All done, ten passes/);
  assert.match(brief, /Finish line: It passes ten times in a row\./);
  assert.match(brief, /also the retry test/);
  // Metered as background spend, on the job's own grant.
  assert.equal(controlPlane.usage.length, 1);
  assert.equal(controlPlane.usage[0].background, true);
  assert.equal(controlPlane.usage[0].input, 50);
});

test("a part out of time is checked too, and a part that did nothing is marked idle", async () => {
  const { w, server, ask, assignBody, advisor } = await setup();
  const { body } = await ask("/agent/machine/assign", assignBody());
  await w.frame(server, { type: "accept", runId: body.runId });
  await w.frame(server, { type: "result", runId: body.runId, outcome: "limit", answer: "", session: "sess_1", wallMs: 1000 });
  const checked = (await ask("/agent/machine/check", { workspaceId: "ws_a", runId: body.runId, job: JOB })).body;
  // Out of time carries on anyway: the advice goes to the next part, and `unfinished` is the cloud's, for a part that stopped on its own.
  assert.equal(checked.exhausted, true);
  assert.equal(checked.unfinished, undefined);
  assert.equal(checked.idle, true);
  assert.match(advisor.asked[0].messages[0].text, /ran out of steps/);
});

test("only the person whose job it is has a run checked, and an unreachable advisor is no verdict", async () => {
  const { w, server, ask, assignBody, advisor } = await setup();
  const { body } = await ask("/agent/machine/assign", assignBody());
  await w.frame(server, { type: "accept", runId: body.runId });
  await w.frame(server, { type: "result", runId: body.runId, outcome: "finished", answer: "Fixed.", session: "sess_1", wallMs: 1000 });
  const stranger = session({ actorUserId: "user_other", workspaces: [{ workspaceId: "ws_a", slug: "seyi", role: "editor", kind: "shared" }] });
  assert.deepEqual((await ask("/agent/machine/check", { workspaceId: "ws_a", runId: body.runId, job: JOB }, stranger)).body, { ok: false, code: "unknown_run" });
  assert.equal(advisor.asked.length, 0);
  assert.equal((await ask("/agent/machine/check", { workspaceId: "ws_a", runId: body.runId, job: { title: "", brief: "" } })).status, 400);
  advisor.reply = null;
  assert.deepEqual((await ask("/agent/machine/check", { workspaceId: "ws_a", runId: body.runId, job: JOB })).body, { ok: true, untrusted: true, idle: true });
});

const CHAT = "a".repeat(64);
const groupSession = (tagger, fields = {}) => session({ actorClientId: "context_texts_group", actorUserId: tagger, texChatId: CHAT, workspaces: [{ workspaceId: "ws_team", slug: "devs", role: "editor", kind: "shared" }], ...fields });

test("a group chat reaches only a computer lent to it, and its owner's ask there is the owner's", async () => {
  const { server, controlPlane, ask, assignBody } = await setup();
  // Not lent: the group's grant doesn't reach the owner's personal workspace at all.
  assert.deepEqual((await ask("/agent/machine/assign", assignBody(), groupSession("user_owner"))).body, { ok: false, code: "unknown_machine" });
  controlPlane.lent.push({ groupKey: CHAT, machineId: "mch_1", workspaceId: "ws_a", ownerId: "user_owner" });
  const { body } = await ask("/agent/machine/assign", assignBody(), groupSession("user_owner"));
  assert.equal(body.ok, true);
  assert.equal(server.last().fromOwner, true);
  // The run grant is minted from the group's own grant: it reaches the chat's workspace, never the owner's notes.
  assert.equal(controlPlane.grants.get(body.runId).parentToken, "cat_parent_token_000000");
  // Lent to a different chat is not lent to this one.
  assert.deepEqual((await ask("/agent/machine/assign", assignBody(), groupSession("user_owner", { texChatId: "b".repeat(64) }))).body, { ok: false, code: "unknown_machine" });
});

test("somebody else in the group gets the computer only as its owner's rule for that chat says", async () => {
  const { w, controlPlane, ask, assignBody } = await setup();
  controlPlane.lent.push({ groupKey: CHAT, machineId: "mch_1", workspaceId: "ws_a", ownerId: "user_owner" });
  // "Only me" by default.
  assert.deepEqual((await ask("/agent/machine/assign", assignBody(), groupSession("user_ade"))).body, { ok: false, code: "rule" });
  const key = `group-${CHAT.slice(0, 58)}`;
  await w.call("ws.machine.set", { id: "mch_1", patch: { chats: { [key]: { who: "everyone" } } } });
  // "Ask me first" stays on unless the owner turned it off.
  const waiting = (await ask("/agent/machine/assign", assignBody(), groupSession("user_ade"))).body;
  assert.equal(waiting.code, "ask_first");
  assert.match(waiting.askId, /^ask_[0-9a-f]{24}$/);
  await w.call("ws.machine.set", { id: "mch_1", patch: { chats: { [key]: { who: "everyone", askFirst: false } } } });
  const { body } = await ask("/agent/machine/assign", assignBody(), groupSession("user_ade"));
  assert.equal(body.ok, true);
  // Only the person who asked reads it back, even in the same chat.
  assert.deepEqual((await ask("/agent/machine/run", { workspaceId: "ws_a", runId: body.runId }, groupSession("user_bola"))).body, { ok: false, code: "unknown_run" });
  assert.equal((await ask("/agent/machine/run", { workspaceId: "ws_a", runId: body.runId }, groupSession("user_ade"))).body.ok, true);
});

test("a group's grant without its chat's key reaches no computer", async () => {
  const { controlPlane, ask, assignBody } = await setup();
  controlPlane.lent.push({ groupKey: CHAT, machineId: "mch_1", workspaceId: "ws_a", ownerId: "user_owner" });
  assert.equal((await ask("/agent/machine/assign", assignBody(), groupSession("user_owner", { texChatId: undefined }))).status, 403);
});

test("Ask me first waits for the owner's own yes, kept by the object, never the caller's word", async () => {
  const { w, controlPlane, ask, assignBody } = await setup();
  controlPlane.lent.push({ groupKey: CHAT, machineId: "mch_1", workspaceId: "ws_a", ownerId: "user_owner" });
  const key = `group-${CHAT.slice(0, 58)}`;
  await w.call("ws.machine.set", { id: "mch_1", patch: { chats: { [key]: { who: "everyone" } } } });
  // A body claiming the yes was given changes nothing.
  const first = (await ask("/agent/machine/assign", assignBody({ approved: true }), groupSession("user_ade"))).body;
  assert.equal(first.code, "ask_first");
  // Asked again, the same ask: one card for the owner, not one per try.
  assert.equal((await ask("/agent/machine/assign", assignBody(), groupSession("user_ade"))).body.askId, first.askId);
  const listed = await w.call("ws.machine.get", { id: "mch_1" });
  assert.deepEqual(listed.machine.asks.map((entry) => [entry.id, entry.askerId, entry.chat]), [[first.askId, "user_ade", key]]);
  // The group's full key rides on the ask, from the grant, so the owner's card can name who asked.
  assert.equal(listed.machine.asks[0].chatKey, CHAT);
  assert.equal((await w.call("ws.machine.answer", { id: "mch_1", askId: first.askId, yes: true })).ok, true);
  assert.equal((await ask("/agent/machine/assign", assignBody(), groupSession("user_ade"))).body.ok, true);
  // The yes was for that job: another job asks again.
  assert.equal((await ask("/agent/machine/assign", assignBody({ jobId: "job_2" }), groupSession("user_ade"))).body.code, "ask_first");
});

test("a no ends the ask, and always lets that person in that chat in without asking", async () => {
  const { w, controlPlane, ask, assignBody } = await setup();
  controlPlane.lent.push({ groupKey: CHAT, machineId: "mch_1", workspaceId: "ws_a", ownerId: "user_owner" });
  const key = `group-${CHAT.slice(0, 58)}`;
  await w.call("ws.machine.set", { id: "mch_1", patch: { chats: { [key]: { who: "everyone" } } } });
  const first = (await ask("/agent/machine/assign", assignBody(), groupSession("user_ade"))).body;
  await w.call("ws.machine.answer", { id: "mch_1", askId: first.askId, yes: false });
  assert.equal((await ask("/agent/machine/assign", assignBody(), groupSession("user_ade"))).body.code, "declined");
  const second = (await ask("/agent/machine/assign", assignBody({ jobId: "job_2" }), groupSession("user_ade"))).body;
  await w.call("ws.machine.answer", { id: "mch_1", askId: second.askId, yes: true, always: true });
  assert.equal((await ask("/agent/machine/assign", assignBody({ jobId: "job_3" }), groupSession("user_ade"))).body.ok, true);
  // Only that person: somebody else in the chat is still asked first.
  assert.equal((await ask("/agent/machine/assign", assignBody({ jobId: "job_4" }), groupSession("user_bola"))).body.code, "ask_first");
});

test("a computer whose Claude Code signed out says why, and in its owner's own texts names the page to sign it in", async () => {
  const { w, server, ask, assignBody } = await setup();
  await w.frame(server, { type: "status", ready: false, notReady: "signed_out", busy: 0, freeMemoryMb: 4000 });
  const { body } = await ask("/agent/machine/assign", assignBody());
  assert.deepEqual(body, { ok: false, code: "not_ready", why: "signed_out", fixAt: "https://app.example.test/tex/@seyi/machine?machine=mch_1" });
  // Someone else's ask, or a group's, gets no link to the owner's page.
  const other = await ask("/agent/machine/assign", assignBody(), session({ actorClientId: "context_texts_group", actorUserId: "user_ade" }));
  assert.equal(other.body.fixAt, undefined);
});
