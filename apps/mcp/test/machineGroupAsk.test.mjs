/**
 * "Ask me first" in the group chat itself (`machines/groupAsk.js`; Dev2,
 * 2026-11-04): a job a group sends to a lent computer asks the chat once, in
 * the gateway's words naming the owner, and only the owner's 👍 or 👎 on it,
 * from their own grant, answers the ask.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { handleMachineJob } from "../src/machines/jobRoutes.js";
import { MACHINE_ASK_OPENING, machineAskLine, machineThumb, machineThumbLine } from "../src/machines/groupAsk.js";
import { jobReportOf, jobReportPrompt, reportReply } from "../src/agent/jobReport.js";
import { serveMachineCall } from "../src/workspaceStore/serveMachines.js";
import { opOf } from "../src/texStore/move.js";
import { machineWorld } from "./machineWorld.mjs";

const ORIGIN = "https://mcp.example.test";
const CHAT = "a".repeat(64);
const KEY = `group-${CHAT.slice(0, 58)}`;

async function setup() {
  const worlds = new Map();
  const world = (id) => {
    if (!worlds.has(id)) worlds.set(id, machineWorld({ workspaceId: id }));
    return worlds.get(id);
  };
  const env = {
    WORKSPACE_STORE: {
      idFromName: (name) => name,
      get: (name) => ({
        async fetch(request) {
          const w = world(name.replace(/^workspace:/, ""));
          return await serveMachineCall({ machines: w.machines, machineSockets: w.sockets }, opOf(request), JSON.parse(await request.text()));
        },
      }),
    },
  };
  const w = world("ws_a");
  const machine = await w.add("mch_1");
  await w.connect(machine);
  await w.call("ws.machine.set", { id: "mch_1", patch: { chats: { [KEY]: { who: "everyone" } } } });
  const controlPlane = {
    lent: [{ groupKey: CHAT, machineId: "mch_1", workspaceId: "ws_a", ownerId: "user_owner" }],
    people: [{ userId: "user_owner", handle: "seyi" }, { userId: "user_ade", handle: "ade" }],
    async texMachinesForChat(groupKey) {
      return this.lent.filter((entry) => entry.groupKey === groupKey).map(({ machineId, workspaceId, ownerId }) => ({ machineId, workspaceId, ownerId }));
    },
    async texMachineChatPeople(userId, groupKey) {
      return groupKey === CHAT && this.people.some((person) => person.userId === userId) ? this.people : null;
    },
    async texMachineRunGrant({ expiresAt }) {
      return { accessToken: "cat_run_1_000000000000", expiresAt };
    },
    async texMachineRunRevoke() {
      return { revoked: 1 };
    },
  };
  const ask = async (body, who) => {
    const path = "/agent/machine/assign";
    const response = await handleMachineJob(new Request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) }), env, who, { path, controlPlane, origin: ORIGIN, store: { contexts: [] }, now: () => w.clock.at, advise: async () => ({ text: "VERDICT: keep_going", usage: {} }) });
    return await response.json();
  };
  const assignBody = (fields = {}) => ({ workspaceId: "ws_a", machineId: "mch_1", jobId: "job_1", part: 1, title: "Fix the flaky test", tool: "claude", folder: "/srv/code", permission: "edits", brief: "Fix it.", doneWhen: "It passes.", ...fields });
  const name = (await w.call("ws.machine.get", { id: "mch_1" })).machine.name;
  return { w, env, controlPlane, ask, assignBody, name };
}

const groupSession = (who, fields = {}) => {
  const s = { actorClientId: "context_texts_group", actorUserId: who, texChatId: CHAT, scopes: ["context:read", "context:write"], workspaces: [{ workspaceId: "ws_team", slug: "devs", role: "editor", kind: "shared" }], ...fields };
  Object.defineProperty(s, "accessToken", { value: "cat_parent_token_000000", enumerable: false });
  return s;
};
const like = (words) => ({ tapback: "Liked", words });

test("a group's first ask to use a lent computer carries the line the chat is asked in, once", async () => {
  const { ask, assignBody, name } = await setup();
  const first = await ask(assignBody(), groupSession("user_ade"));
  assert.equal(first.code, "ask_first");
  assert.equal(first.askLine, machineAskLine({ title: "Fix the flaky test", machineName: name, ownerHandle: "seyi" }));
  assert.match(first.askLine, /^@seyi: Give this a 👍 and I'll start "Fix the flaky test" on @seyi's computer/);
  // Asked again while it waits: the same ask, and the chat is not asked twice.
  const again = await ask(assignBody(), groupSession("user_ade"));
  assert.equal(again.askId, first.askId);
  assert.equal(again.askLine, undefined);
});

test("only the computer's owner's 👍 answers the ask, and the job then starts", async () => {
  const { w, env, controlPlane, ask, assignBody } = await setup();
  const { askLine, askId } = await ask(assignBody(), groupSession("user_ade"));
  // The asker's own 👍, another member's, and a guest's on the owner's grant are no one's yes.
  assert.equal(await machineThumb(env, groupSession("user_ade"), like(askLine), controlPlane), null);
  assert.equal(await machineThumb(env, groupSession("user_bola"), like(askLine), controlPlane), null);
  assert.equal(await machineThumb(env, groupSession("user_owner"), like(askLine), controlPlane, { guest: true }), null);
  // The owner's 👍 on other words, or on another chat's ask, answers nothing.
  assert.equal(await machineThumb(env, groupSession("user_owner"), like(`${MACHINE_ASK_OPENING} "Something else" on the computer`), controlPlane), null);
  assert.equal(await machineThumb(env, groupSession("user_owner", { texChatId: "b".repeat(64) }), like(askLine), controlPlane), null);
  assert.equal((await w.call("ws.machine.get", { id: "mch_1" })).machine.asks[0].id, askId);
  const answered = await machineThumb(env, groupSession("user_owner"), like(askLine), controlPlane);
  assert.equal(answered.yes, true);
  assert.match(machineThumbLine(answered), /^Thanks, "Fix the flaky test" can run on /);
  assert.equal((await ask(assignBody(), groupSession("user_ade"))).ok, true);
});

test("the owner's 👎 is the no, and a 👍 after it changes nothing", async () => {
  const { env, controlPlane, ask, assignBody } = await setup();
  const { askLine } = await ask(assignBody(), groupSession("user_ade"));
  assert.equal((await machineThumb(env, groupSession("user_owner"), { tapback: "Disliked", words: askLine }, controlPlane)).yes, false);
  assert.equal(await machineThumb(env, groupSession("user_owner"), like(askLine), controlPlane), null);
  assert.equal((await ask(assignBody(), groupSession("user_ade"))).code, "declined");
});

test("an ask from someone's own texts is never put to a group", async () => {
  const { w, ask, assignBody } = await setup();
  await w.call("ws.machine.set", { id: "mch_1", patch: { chats: { "texts-user_ade": { who: "everyone" } } } });
  const own = { actorClientId: "context_texts", actorUserId: "user_ade", scopes: ["context:read", "context:write"], workspaces: [{ workspaceId: "ws_a", slug: "devs", role: "editor", kind: "shared" }] };
  Object.defineProperty(own, "accessToken", { value: "cat_parent_token_000000", enumerable: false });
  const answer = await ask(assignBody(), own);
  assert.equal(answer.code, "ask_first");
  assert.equal(answer.askLine, undefined);
});

test("the chat's Tex texts the owner's ask word for word, whatever its model said", () => {
  const ask = machineAskLine({ title: "Fix the flaky test", machineName: "Studio Mac", ownerHandle: "seyi" });
  const report = jobReportOf({ event: "job_report", jobReport: { title: "Fix the flaky test", state: "running", texts: [ask], ask } }, { chatTurn: true, job: null });
  assert.equal(report.ask, ask);
  assert.match(jobReportPrompt(report), /answer exactly SKIP/);
  assert.deepEqual(reportReply(report, "SKIP"), { answer: ask, quiet: false });
  assert.deepEqual(reportReply(report, "Seyi, can I use your Mac?"), { answer: ask, quiet: false });
  // A job's own words that only look like one are not the gateway's ask, and an ended job's report carries none.
  assert.equal(jobReportOf({ event: "job_report", jobReport: { title: "x", state: "running", texts: ["hi"], ask: "Please 👍 this" } }, { chatTurn: true, job: null }).ask, undefined);
  assert.equal(jobReportOf({ event: "job_report", jobReport: { title: "x", state: "done", texts: [ask], ask } }, { chatTurn: true, job: null }).ask, undefined);
});
