/**
 * A texted turn starting a job on one of the person's own computers
 * (`machines/forJobs.js`, `agent/background.js` `on_computer`): the computer is
 * found among theirs by name, or alone, its tool and folder checked, and the
 * job the Worker starts carries it. Only their own 1:1 chat may ask.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pickMachine } from "../src/machines/forJobs.js";
import { WORK_FOLDER } from "../src/workspaceStore/machines.js";
import { backgroundSession, START_JOB_TOOL, startedJobs, withBackground } from "../src/agent/background.js";

const STUDIO = { workspaceId: "ws_seyi", id: "mch_1", name: "Studio Mac", online: true, tools: ["claude", "codex"], folders: ["/Users/seyi/code"], ownerId: "user_seyi" };
const VM = { workspaceId: "ws_devs", id: "mch_2", name: "Tex Devs VM", online: false, tools: ["claude"], folders: ["/srv/code"], ownerId: "user_ade" };

test("a computer is found by its name, or alone, with its tool and folder checked", () => {
  assert.deepEqual(pickMachine([STUDIO], {}).machine, { workspaceId: "ws_seyi", machineId: "mch_1", name: "Studio Mac", tool: "claude", folder: "/Users/seyi/code" });
  assert.equal(pickMachine([STUDIO, VM], { name: "tex devs vm" }).machine.machineId, "mch_2");
  assert.equal(pickMachine([STUDIO, VM], { name: "studio" }).machine.machineId, "mch_1");
  assert.match(pickMachine([STUDIO, VM], {}).error, /"Studio Mac", "Tex Devs VM" \(offline\)/);
  assert.match(pickMachine([STUDIO], { tool: "codex", folder: "/etc" }).error, /only in \/Users\/seyi\/code/);
  assert.match(pickMachine([VM], { tool: "codex" }).error, /can run claude/);
  assert.match(pickMachine([], {}).error, /no computer paired/);
  // None of theirs chosen: the computer's own work folder, so a sign-in or a scratch job needs no setup (owner, 2026-11-05).
  assert.equal(pickMachine([{ ...STUDIO, os: "macos", folders: [] }], {}).machine.folder, WORK_FOLDER);
  assert.equal(pickMachine([{ ...VM, os: "linux", folders: [] }], {}).machine.folder, "@work");
  // A folder the turn names is still only one of theirs.
  assert.match(pickMachine([{ ...VM, folders: [] }], { folder: "/etc" }).error, /leave the folder out/);
  for (const repo of ["../../etc", "/etc", "a/../../b", "a/b/c"]) assert.equal(pickMachine([STUDIO], { repo }).machine.repo, undefined, repo);
  assert.equal(pickMachine([STUDIO], { repo: "Supa-Media/context" }).machine.repo, "Supa-Media/context");
});

test("the job the Worker starts carries the computer it runs on", async () => {
  const background = backgroundSession({ running: [], job: null, now: 1, machines: async () => [STUDIO] });
  const call = withBackground(background, async () => assert.fail("not a background call"));
  const answer = await call(START_JOB_TOOL, { title: "Fix the flaky test", brief: "Find why it flakes and fix it.", on_computer: { name: "Studio Mac", tool: "codex" } });
  assert.notEqual(answer.isError, true);
  const { jobs } = startedJobs(background, false);
  assert.deepEqual(jobs[0].machine, { workspaceId: "ws_seyi", machineId: "mch_1", name: "Studio Mac", tool: "codex", folder: "/Users/seyi/code" });
});

test("only a person's own chat can put a job on a computer", async () => {
  const background = backgroundSession({ running: [], job: null, now: 1 });
  const call = withBackground(background, async () => null);
  const answer = await call(START_JOB_TOOL, { title: "Fix it", brief: "Fix the test.", on_computer: {} });
  assert.equal(answer.isError, true);
  assert.equal(startedJobs(background, false).jobs, undefined);
});

test("in a group chat, the computers Tex may name are the ones lent to it", async () => {
  const { machinesFor } = await import("../src/machines/forJobs.js");
  const calls = [];
  const env = {
    WORKSPACE_STORE: {
      idFromName: (name) => name,
      get: (name) => ({
        async fetch(request) {
          const fields = JSON.parse(await request.text());
          calls.push({ name, fields });
          return Response.json({ ok: true, machine: { id: fields.id, name: "Studio Mac", online: true, tools: ["claude"], folders: ["/code"], ownerId: "user_owner" } });
        },
      }),
    },
  };
  const controlPlane = { texMachinesForChat: async () => [{ machineId: "mch_1", workspaceId: "ws_seyi", ownerId: "user_owner" }] };
  const group = { actorClientId: "context_texts_group", actorUserId: "user_ade", texChatId: "a".repeat(64), workspaces: [{ workspaceId: "ws_team", role: "editor", kind: "shared" }] };
  const found = await machinesFor(env, group, controlPlane);
  assert.deepEqual(found.map((machine) => [machine.workspaceId, machine.id]), [["ws_seyi", "mch_1"]]);
  // The chat's own workspace is never listed for its computers: only what was lent.
  assert.ok(calls.every((call) => !String(call.name).includes("ws_team")));
});

test("a deployment that binds MACHINE_STORE reads its computers there, with their slots, and only for the person's own texts", async () => {
  const { machinesFor } = await import("../src/machines/forJobs.js");
  const { TEXTS_CLIENT_ID } = await import("../src/machines/reach.js");
  const asked = [];
  const env = {
    MACHINE_STORE: {
      idFromName: (name) => name,
      get: (name) => ({
        async fetch(request) {
          asked.push({ name, op: new URL(request.url).pathname.slice(1) });
          return Response.json({ ok: true, machines: [{ id: "mch_bench", name: "Studio Mac", online: true, tools: ["claude", "codex"], folders: ["~/code"], ownerId: "user_maya", limits: { slots: 3 } }] });
        },
      }),
    },
  };
  const own = { actorClientId: TEXTS_CLIENT_ID, workspaceId: "ws_maya", workspaces: [{ workspaceId: "ws_maya", role: "owner", kind: "personal" }] };
  const found = await machinesFor(env, own);
  assert.deepEqual(found.map((machine) => [machine.name, machine.slots, machine.tools]), [["Studio Mac", 3, ["claude", "codex"]]]);
  assert.deepEqual(asked.map((call) => call.op), ["ws.machine.list"]);
  assert.deepEqual(await machinesFor(env, { ...own, actorClientId: "some_other_client" }), [], "another client still names none");
  assert.deepEqual(await machinesFor({}, own), [], "no store, no computers");
});
