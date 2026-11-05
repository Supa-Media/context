/**
 * A machine in its workspace object: the runner's socket proves its key before
 * anything is read, frames are validated, a job takes a slot only inside the
 * owner's rules, and a dropped connection resumes the same session. The
 * isolation tests here are the design doc's threat table
 * (docs/decisions/texting-assistant/machines.md).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { foldersOf } from "../src/workspaceStore/machines.js";
import { CLOSE_PROTOCOL, CLOSE_REAUTH, MACHINE_SOCKET_MAX_MS } from "../src/workspaceStore/machineSockets.js";
import { FACTS, keyPair, machineWorld, protocol } from "./machineWorld.mjs";

const parsedServer = (frame) => protocol.parseServerFrame(JSON.stringify(frame));

test("a runner that signs the challenge is welcomed with the owner's rules", async () => {
  const world = machineWorld();
  const machine = await world.add();
  const server = await world.connect(machine);
  assert.equal(server.sent[0].type, "challenge");
  const welcome = server.last();
  assert.equal(welcome.type, "welcome");
  assert.deepEqual(welcome.rules.folders, ["/srv/code"]);
  assert.equal(welcome.rules.limits.longestRunMs, 4 * 60 * 60 * 1000);
  for (const frame of server.sent) assert.equal(parsedServer(frame).ok, true, frame.type);
  assert.equal(world.sockets.online(machine.id), true);
  // The first report sizes the slots at the recommended count.
  assert.equal(world.machines.get(machine.id).limits.slots, 2);
  assert.deepEqual(world.events.at(-1), { kind: "online", machineId: machine.id });
});

test("a stolen grant without the machine's key opens nothing", async () => {
  const world = machineWorld();
  const machine = await world.add();
  const thief = await keyPair();
  const server = await world.connect(machine, { sign: thief.sign });
  assert.deepEqual(server.last(), { type: "goodbye", reason: "bad_signature" });
  assert.equal(server.closed.code, CLOSE_PROTOCOL);
  assert.equal(world.sockets.online(machine.id), false);
});

test("a signature for another machine, or a pairing signature, never passes as a hello", async () => {
  const world = machineWorld();
  const a = await world.add("mch_a");
  const b = await world.add("mch_b");
  // The gateway resolved A's grant; the runner claims to be B with B's own valid key.
  const { server } = world.open(a.id);
  const signature = await b.keys.sign(protocol.helloSigningText(b.id, server.sent[0].nonce));
  await world.frame(server, { type: "hello", protocol: 1, machineId: b.id, signature, runner: "0.1.0", facts: { os: "linux", arch: "x", memoryMb: 1, cores: 1, tools: [] }, slots: { recommended: 1, most: 1 }, runs: [] });
  assert.equal(server.last().reason, "bad_signature");
  assert.equal(world.sockets.online(b.id), false);
  const other = await world.connect(a, { sign: (text) => a.keys.sign(protocol.pairSigningText(text)) });
  assert.equal(other.last().reason, "bad_signature");
});

test("nothing but a hello is read before the key is proven, and a bad frame closes the socket", async () => {
  const world = machineWorld();
  const machine = await world.add();
  const early = world.open(machine.id).server;
  await world.frame(early, { type: "status", ready: true, busy: 0, freeMemoryMb: 100 });
  assert.equal(early.closed.code, CLOSE_PROTOCOL);
  assert.equal(world.machines.get(machine.id).status, null);
  const server = await world.connect(machine);
  await world.frame(server, { type: "run_command", command: "rm -rf /" });
  assert.equal(server.closed.code, CLOSE_PROTOCOL);
  const again = await world.connect(machine);
  await world.frame(again, "not json");
  assert.equal(again.closed.code, CLOSE_PROTOCOL);
});

test("one tenant's runner never reaches another's machine", async () => {
  const alice = machineWorld({ workspaceId: "ws_alice" });
  const bob = machineWorld({ workspaceId: "ws_bob" });
  const machine = await alice.add("mch_alice");
  // Bob's object has no such machine: the socket is refused before a challenge.
  assert.equal(bob.open(machine.id).response.status, 404);
  assert.equal(bob.open("../mch").response.status, 400);
  const answer = await bob.call("ws.machine.assign", bob.assignment(machine.id));
  assert.equal(answer.code, "unknown_machine");
});

test("a newer connection replaces an older one", async () => {
  const world = machineWorld();
  const machine = await world.add();
  const first = await world.connect(machine);
  const second = await world.connect(machine);
  assert.deepEqual(first.last(), { type: "goodbye", reason: "replaced" });
  assert.equal(first.readyState, 3);
  assert.equal(second.last().type, "welcome");
  assert.equal(world.sockets.online(machine.id), true);
});

test("an owner's job runs end to end: assign, accept, session, steps, result, usage", async () => {
  const world = machineWorld();
  const machine = await world.add();
  const server = await world.connect(machine);
  const answer = await world.call("ws.machine.assign", world.assignment(machine.id));
  assert.equal(answer.ok, true);
  const assign = server.last();
  assert.equal(parsedServer(assign).ok, true);
  assert.equal(assign.type, "assign");
  assert.equal(assign.runId, answer.runId);
  assert.deepEqual([assign.network, assign.helpers, assign.computerUse], [true, true, false]);
  const runId = answer.runId;
  await world.frame(server, { type: "accept", runId });
  await world.frame(server, { type: "session", runId, session: "sess-1" });
  await world.frame(server, { type: "step", runId, seq: 1, tool: "Bash", target: "pnpm test", at: world.clock.at });
  await world.frame(server, { type: "step", runId, seq: 1, tool: "Bash", target: "pnpm test", at: world.clock.at }); // a resend
  await world.frame(server, { type: "result", runId, outcome: "finished", answer: "Fixed.", session: "sess-1", wallMs: 600000 });
  const run = (await world.call("ws.machine.run", { runId })).run;
  assert.equal(run.state, "ended");
  assert.equal(run.session, "sess-1");
  assert.equal(run.steps.length, 1);
  assert.equal(run.result.answer, "Fixed.");
  assert.deepEqual(world.events.filter((e) => e.runId === runId).map((e) => e.kind), ["accepted", "session", "step", "result"]);
  assert.equal(world.machines.used(machine.id).todayMs, 600000);
});

test("an ask from somebody the owner did not allow never reaches the runner", async () => {
  const world = machineWorld();
  const machine = await world.add();
  const server = await world.connect(machine);
  const before = server.sent.length;
  const bola = { fromOwner: false, askerId: "user_bola", chat: "chat_devs" };
  // Not attached to the chat at all.
  assert.equal((await world.call("ws.machine.assign", world.assignment(machine.id, bola))).code, "rule");
  // Attached with the default: Only me.
  await world.call("ws.machine.set", { id: machine.id, patch: { chats: { chat_devs: {} } } });
  assert.equal(world.machines.get(machine.id).chats.chat_devs.who, "owner");
  assert.equal((await world.call("ws.machine.assign", world.assignment(machine.id, bola))).code, "rule");
  // Picked people, Bola not among them.
  await world.call("ws.machine.set", { id: machine.id, patch: { chats: { chat_devs: { who: ["user_ade"] } } } });
  assert.equal((await world.call("ws.machine.assign", world.assignment(machine.id, bola))).code, "rule");
  // Everyone, with Ask me first on by default: held for the owner's yes.
  await world.call("ws.machine.set", { id: machine.id, patch: { chats: { chat_devs: { who: "everyone" } } } });
  assert.equal((await world.call("ws.machine.assign", world.assignment(machine.id, bola))).code, "ask_first");
  assert.ok(server.sent.slice(before).every((frame) => frame.type === "rules"));
});

test("other people's runs get full permissions but never computer use, or the network unless the chat allows it", async () => {
  const world = machineWorld();
  const machine = await world.add("mch_1", { computerUse: true });
  const server = await world.connect(machine);
  await world.call("ws.machine.set", { id: machine.id, patch: { chats: { chat_devs: { who: "everyone", askFirst: false } } } });
  const answer = await world.call("ws.machine.assign", world.assignment(machine.id, { fromOwner: false, askerId: "user_bola", chat: "chat_devs", computerUse: true, permission: "full" }));
  assert.equal(answer.ok, true);
  const assign = server.last();
  // Plain Claude Code for anyone the owner lets in (owner, 2026-11-04).
  assert.deepEqual([assign.computerUse, assign.network, assign.helpers, assign.permission, assign.fromOwner], [false, false, false, "full", false]);
  // The owner's own ask may use the screen when the machine allows it.
  const own = await world.call("ws.machine.assign", world.assignment(machine.id, { jobId: "job_2", computerUse: true }));
  assert.equal(own.ok, true);
  assert.equal(server.last().computerUse, true);
});

test("a run never starts outside the allowed folders, and a home folder is never allowed", async () => {
  const world = machineWorld();
  const machine = await world.add();
  await world.connect(machine);
  assert.equal((await world.call("ws.machine.assign", world.assignment(machine.id, { folder: "/etc" }))).code, "folder");
  assert.equal((await world.call("ws.machine.assign", world.assignment(machine.id, { folder: "/srv/code/../.." }))).code, "folder");
  assert.deepEqual(foldersOf(["/", "/home/seyi", "/Users/seyi/", "/root", "relative", "/srv/a/../b", "/srv/code", "/home/seyi/code"]), ["/srv/code", "/home/seyi/code"]);
});

test("two chats sharing a machine never overfill it, and the owner's kept slot stays free", async () => {
  const world = machineWorld();
  const machine = await world.add("mch_1", { limits: { slots: 2, keepOneForOwner: true } });
  await world.connect(machine);
  await world.call("ws.machine.set", { id: machine.id, patch: { limits: { slots: 2, keepOneForOwner: true }, chats: { chat_a: { who: "everyone", askFirst: false, slots: 2 }, chat_b: { who: "everyone", askFirst: false, slots: 2 } } } });
  const other = (chat, jobId) => world.assignment(machine.id, { fromOwner: false, askerId: "user_bola", chat, jobId });
  assert.equal((await world.call("ws.machine.assign", other("chat_a", "job_a"))).ok, true);
  assert.equal((await world.call("ws.machine.assign", other("chat_b", "job_b"))).code, "busy", "the last slot is kept for the owner");
  assert.equal((await world.call("ws.machine.assign", world.assignment(machine.id, { jobId: "job_own" }))).ok, true);
  assert.equal((await world.call("ws.machine.assign", world.assignment(machine.id, { jobId: "job_own2" }))).code, "busy");
});

test("limits are enforced from the machine's own counters", async () => {
  const world = machineWorld();
  const machine = await world.add("mch_1", { limits: { slots: 3, dayMs: 3600000, othersDayMs: 600000, othersRunsPerDay: 1 } });
  const server = await world.connect(machine);
  await world.call("ws.machine.set", { id: machine.id, patch: { chats: { chat_a: { who: "everyone", askFirst: false, slots: 3 } } } });
  const other = (jobId) => world.assignment(machine.id, { fromOwner: false, askerId: "user_bola", chat: "chat_a", jobId });
  const first = await world.call("ws.machine.assign", other("job_1"));
  assert.equal(first.ok, true);
  assert.equal((await world.call("ws.machine.assign", other("job_2"))).code, "limit_others", "one run a day for others");
  await world.frame(server, { type: "result", runId: first.runId, outcome: "finished", wallMs: 3600000 });
  assert.equal((await world.call("ws.machine.assign", world.assignment(machine.id, { jobId: "job_own" }))).code, "limit_day");
  // The next day in the owner's time zone starts fresh (the runner has reconnected meanwhile).
  world.clock.at += 24 * 60 * 60 * 1000;
  await world.connect(machine);
  assert.equal((await world.call("ws.machine.assign", world.assignment(machine.id, { jobId: "job_own" }))).ok, true);
});

test("a run asks no more than the machine's longest job, and a plan-limit signal pauses the machine", async () => {
  const world = machineWorld();
  const machine = await world.add();
  const server = await world.connect(machine);
  const answer = await world.call("ws.machine.assign", world.assignment(machine.id, { deadline: world.clock.at + 48 * 3600000 }));
  assert.equal(answer.deadline, world.clock.at + 4 * 3600000);
  await world.frame(server, { type: "usage", runId: answer.runId, wallMs: 1000, planLimited: true, planResetsAt: world.clock.at + 7200000 });
  const held = await world.call("ws.machine.assign", world.assignment(machine.id, { jobId: "job_2" }));
  assert.equal(held.code, "plan_limit");
  assert.equal(held.until, world.clock.at + 7200000);
});

test("after a dropped connection the job resumes the same session; a run the runner lost ends as lost", async () => {
  const world = machineWorld();
  const machine = await world.add();
  const server = await world.connect(machine);
  const kept = await world.call("ws.machine.assign", world.assignment(machine.id, { jobId: "job_kept" }));
  const lost = await world.call("ws.machine.assign", world.assignment(machine.id, { jobId: "job_lost" }));
  await world.frame(server, { type: "session", runId: kept.runId, session: "sess-kept" });
  await world.frame(server, { type: "step", runId: kept.runId, seq: 5, tool: "Edit", at: world.clock.at });
  server.readyState = 3;
  await world.sockets.closed(server);
  assert.equal(world.events.at(-1).kind, "offline");
  assert.equal(world.sockets.online(machine.id), false);
  const back = await world.connect(machine, { runs: [{ runId: kept.runId, alive: true, session: "sess-kept", lastStep: 7 }] });
  assert.deepEqual(back.last().keepRuns, [kept.runId]);
  const resumed = world.events.find((e) => e.kind === "resumed");
  assert.deepEqual([resumed.runId, resumed.alive, resumed.session], [kept.runId, true, "sess-kept"]);
  assert.equal((await world.call("ws.machine.run", { runId: kept.runId })).run.lastStep, 7);
  const gone = (await world.call("ws.machine.run", { runId: lost.runId })).run;
  assert.deepEqual([gone.state, gone.result.outcome], ["ended", "lost"]);
});

test("a socket past its hour reconnects through the gateway, which checks the grant again", async () => {
  const world = machineWorld();
  const machine = await world.add();
  const server = await world.connect(machine);
  world.clock.at += MACHINE_SOCKET_MAX_MS + 1;
  await world.frame(server, { type: "status", ready: true, busy: 0, freeMemoryMb: 100 });
  assert.equal(server.closed.code, CLOSE_REAUTH);
  assert.equal(world.sockets.online(machine.id), false);
});

test("cancel ends an offline machine's run here, and disconnecting a machine says goodbye and ends its runs", async () => {
  const world = machineWorld();
  const machine = await world.add();
  const server = await world.connect(machine);
  const one = await world.call("ws.machine.assign", world.assignment(machine.id, { jobId: "job_1" }));
  const two = await world.call("ws.machine.assign", world.assignment(machine.id, { jobId: "job_2" }));
  await world.call("ws.machine.cancel", { runId: one.runId });
  assert.deepEqual(server.last(), { type: "cancel", runId: one.runId, reason: "stopped" });
  const removed = await world.call("ws.machine.remove", { id: machine.id });
  assert.ok(removed.ended.some((run) => run.runId === two.runId));
  assert.ok(server.sent.some((frame) => frame.type === "goodbye" && frame.reason === "revoked"));
  assert.equal(world.machines.get(machine.id), null);
  assert.equal(world.open(machine.id).response.status, 404);
  assert.equal((await world.call("ws.machine.assign", world.assignment(machine.id))).code, "unknown_machine");
});

test("settings refuse unknown keys, and a machine's owner and key never change", async () => {
  const world = machineWorld();
  const machine = await world.add();
  assert.equal((await world.call("ws.machine.set", { id: machine.id, patch: { ownerId: "user_eve" } })).code, "bad_setting");
  assert.equal((await world.call("ws.machine.set", { id: machine.id, patch: { publicKey: "x" } })).code, "bad_setting");
  const thief = await keyPair();
  assert.equal((await world.call("ws.machine.add", { machine: { id: machine.id, ownerId: "user_owner", publicKey: thief.publicKey } })).code, "bad_machine");
  const listed = (await world.call("ws.machine.list", {})).machines;
  assert.equal(listed.length, 1);
  assert.equal("publicKey" in listed[0], false);
});

test("deliver and interrupt reach only a live run", async () => {
  const world = machineWorld();
  const machine = await world.add();
  const server = await world.connect(machine);
  const run = await world.call("ws.machine.assign", world.assignment(machine.id));
  assert.equal((await world.call("ws.machine.deliver", { runId: run.runId, messageId: "msg_1", kind: "ask", from: "minion-2", app: "Claude", path: "projects/x.md", text: "Moved?" })).ok, true);
  assert.equal(server.last().type, "message");
  assert.equal((await world.call("ws.machine.interrupt", { runId: run.runId, messageId: "msg_2", from: "tex", text: "Stop." })).ok, true);
  assert.equal(server.last().type, "interrupt");
  assert.equal((await world.call("ws.machine.deliver", { runId: "run_none", messageId: "m", kind: "note", from: "x", text: "y" })).code, "unknown_run");
  assert.equal((await world.call("ws.machine.deliver", { runId: run.runId, messageId: "m", kind: "interrupt", from: "x", text: "y" })).code, "bad_message", "an interrupt never rides as a mail kind");
});

// A Mac registered before the register path kept the runner's OS was saved as
// "linux" and the page said "Online · Linux". The runner's hello repairs it.
test("the runner's reported OS replaces a wrong one on the machine row", async () => {
  const world = machineWorld();
  const machine = await world.add("mch_mac", { os: "linux" });
  await world.connect(machine, { hello: { facts: { ...FACTS, os: "macos" } } });
  assert.equal(world.machines.get(machine.id).os, "macos");
});
