/**
 * A mail-only device in its workspace object: a session's own computer (a cloud VM's Claude Code), paired through
 * that session's Context connection (`pair_device`). It shows up in the devices list, gets note mail down its socket
 * at once, never takes a job, cannot be turned into a computer that does, and leaves on its own when its session is
 * gone (docs/decisions/texting-assistant/machines.md, "A cloud VM as a mail-only device"; owner, 2026-11-04: "fine
 * for them to show up, but not to take jobs, but to receive mail").
 *
 * The end-to-end proof with the real runner is `test/e2e/vmDeviceMail.e2e.mjs`.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `admit` without the `mail_only` refusal → "a mail-only device never takes a job, whoever asks".
 *  2. `MAIL_ONLY_SETTABLE` replaced by `SETTABLE` → "only its name can be changed".
 *  3. `leaving` without the offline rule → "a device offline for fifteen minutes leaves the list".
 *  4. `deliverMail` without the `own` filter for machines → "an interrupt from someone else's agent never reaches a device".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MAIL_ONLY_OFFLINE_MS } from "../src/workspaceStore/machines.js";
import { deliverMail } from "../src/mail/deliver.js";
import { machineWorld, protocol } from "./machineWorld.mjs";

const DAY = 24 * 60 * 60 * 1000;
const mailOf = (text, fields = {}) => ({ messageId: "ml_1", kind: "ask", from: "lead", to: "vm", text, path: "projects/a.md", at: 1, ...fields });

async function aDevice(world, id = "mch_vm") {
  return await world.add(id, { mailOnly: true, expiresAt: world.clock.at + DAY, folders: [] });
}

test("a mail-only device shows up as one, with no tools, and its runner is welcomed", async () => {
  const world = machineWorld();
  const device = await aDevice(world);
  const listed = (await world.call("ws.machine.list", {})).machines.find((machine) => machine.id === device.id);
  assert.equal(listed.mailOnly, true);
  assert.deepEqual(listed.tools, []);
  const server = await world.connect(device);
  assert.equal(server.last().type, "welcome");
  assert.equal(world.sockets.online(device.id), true);
});

test("a mail-only device never takes a job, whoever asks", async () => {
  const world = machineWorld();
  const device = await aDevice(world);
  await world.connect(device);
  const answer = await world.call("ws.machine.assign", world.assignment(device.id, { fromOwner: true }));
  assert.equal(answer.ok, false);
  assert.equal(answer.code, "mail_only");
});

test("only its name can be changed: nothing set from the app gives it tools or folders", async () => {
  const world = machineWorld();
  const device = await aDevice(world);
  assert.equal((await world.call("ws.machine.set", { id: device.id, patch: { name: "laptop vm" } })).ok, true);
  for (const patch of [{ tools: ["claude"] }, { folders: ["/srv/code"] }, { limits: { slots: 2 } }, { mailOnly: false }]) {
    const answer = await world.call("ws.machine.set", { id: device.id, patch });
    assert.equal(answer.ok, false, JSON.stringify(patch));
  }
  const after = (await world.call("ws.machine.get", { id: device.id })).machine;
  assert.equal(after.name, "laptop vm");
  assert.equal(after.mailOnly, true);
  assert.deepEqual(after.tools, []);
  // Added again (a reconnecting pairing), it stays mail-only even if the add forgets to say so.
  await world.call("ws.machine.add", { machine: { id: device.id, name: device.id, os: "linux", ownerId: "user_owner", publicKey: device.keys.publicKey } });
  assert.equal((await world.call("ws.machine.get", { id: device.id })).machine.mailOnly, true);
});

test("mail goes down the device's socket as a valid mail frame, and is not sent while it is offline", async () => {
  const world = machineWorld();
  const device = await aDevice(world);
  assert.equal((await world.call("ws.machine.mail", { id: device.id, mail: mailOf("offline") })).sent, false);
  const server = await world.connect(device);
  const answer = await world.call("ws.machine.mail", { id: device.id, mail: mailOf("Did the API types move?") });
  assert.equal(answer.sent, true);
  const frame = server.last();
  assert.equal(frame.type, "mail");
  assert.equal(frame.text, "Did the API types move?");
  assert.equal(protocol.parseServerFrame(JSON.stringify(frame)).ok, true);
  const bad = await world.call("ws.machine.mail", { id: device.id, mail: { ...mailOf("x"), command: "rm -rf /" } });
  assert.equal(bad.ok, false, "a mail frame carries mail and nothing else");
});

test("a device offline for fifteen minutes leaves the list, and one past its day is refused at the socket", async () => {
  const world = machineWorld();
  const device = await aDevice(world);
  const server = await world.connect(device);
  world.sockets.closed(server);
  world.clock.at += MAIL_ONLY_OFFLINE_MS - 1000;
  assert.ok((await world.call("ws.machine.list", {})).machines.some((machine) => machine.id === device.id));
  world.clock.at += 2000;
  assert.ok(!(await world.call("ws.machine.list", {})).machines.some((machine) => machine.id === device.id));

  const other = machineWorld();
  const kept = await aDevice(other, "mch_late");
  await other.connect(kept);
  other.clock.at += DAY + 1;
  assert.notEqual(other.open(kept.id).response.status, 101);
});

test("a full machine never leaves on its own", async () => {
  const world = machineWorld();
  const machine = await world.add("mch_mac");
  world.clock.at += 30 * DAY;
  assert.ok((await world.call("ws.machine.list", {})).machines.some((row) => row.id === machine.id));
});

test("an interrupt from someone else's agent never reaches a device; an ask to it does", async () => {
  const sent = [];
  const env = {
    WORKSPACE_STORE: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (request) => {
          sent.push({ id, op: request.headers.get("x-tex-op") ?? request.url, body: JSON.parse(await request.text()) });
          return new Response(JSON.stringify({ ok: true, sent: true }));
        },
      }),
    },
  };
  const boxes = async () => [
    { mailboxId: "mb_vm", name: "vm", machineId: "mch_vm", machineWorkspaceId: "ws_vm", own: false },
  ];
  const line = { path: "projects/a.md", at: new Date().toISOString(), from: "lead", app: "Claude", to: "vm", mailKind: "interrupt", text: "stop" };
  assert.deepEqual(await deliverMail(env, { jobMailboxes: boxes }, line), []);
  assert.deepEqual(sent, []);
  assert.deepEqual(await deliverMail(env, { jobMailboxes: boxes }, { ...line, mailKind: "ask", text: "status?" }), ["vm"]);
  assert.equal(sent.length, 1);
  assert.match(String(sent[0].id), /ws_vm/, "pushed through the device's own workspace object");
  assert.equal(sent[0].body.id, "mch_vm");
  assert.equal(sent[0].body.workspaceId, "ws_vm", "every call to a workspace object names its workspace");
  assert.equal(sent[0].body.mail.kind, "ask");
  // The sender's own name is never handed its own line.
  assert.deepEqual(await deliverMail(env, { jobMailboxes: boxes }, { ...line, from: "vm", mailKind: "note" }), []);
});
