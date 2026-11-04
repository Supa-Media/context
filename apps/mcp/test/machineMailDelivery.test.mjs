/**
 * Note mail to a mail-only device, end to end on the gateway side: `deliverMail` hands the line to the device's own
 * workspace object through the object's real entry (`serveWorkspaceStore`), as production does, and the frame goes
 * down the runner's socket.
 *
 * The 2026-11-04 live check from a cloud VM found the line never left the gateway: the call named no workspace, so the
 * object refused it before it reached the machine, and `machineMailOnly.test.mjs` did not see it because its stub
 * answered with `serveMachineCall` directly, past that check. This one goes through the object's front door.
 *
 * A line sent while the device's runner is between sockets is not lost: the object keeps a device's recent mail and
 * hands it over again on every hello. The runner keeps a line once by its id, so a repeat is harmless. A socket that
 * died without closing still looks open for a while, so mail is kept whether or not a send seemed to work.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `toMachine` without `workspaceId` in its call → "a line sent to a device reaches its runner's socket".
 *  2. `hello` without the replay → "mail sent while a device reconnects reaches it when it is back".
 *  3. `holdMail` keeping no time limit → "only recent mail is handed over again, and none once the device is gone".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { deliverMail } from "../src/mail/deliver.js";
import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { machineWorld, protocol } from "./machineWorld.mjs";

function sqlite() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        const rows = statement.all(...binds);
        return { toArray: () => rows };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

/** One workspace object, answering through its real entry, with the machine side of `world`. */
function objectFor(world) {
  const sql = sqlite();
  const store = { sql, objects: texObjects(sql), rows: workspaceRows(sql), members: workspaceMembers(sql), machines: world.machines, machineSockets: world.sockets };
  const names = [];
  return {
    names,
    env: {
      WORKSPACE_STORE: {
        idFromName: (name) => ({ name }),
        get: (id) => {
          names.push(id.name);
          return { fetch: (request) => serveWorkspaceStore(store, request) };
        },
      },
    },
  };
}

const line = { path: "projects/a.md", at: new Date().toISOString(), from: "lead", app: "Claude", to: "vm", mailKind: "note", text: "Did the API types move?" };

test("a line sent to a device reaches its runner's socket", async () => {
  const world = machineWorld({ workspaceId: "ws_vm" });
  const device = await world.add("mch_vm", { mailOnly: true, expiresAt: world.clock.at + 86_400_000, folders: [] });
  const server = await world.connect(device);
  const object = objectFor(world);
  const boxes = async () => [{ mailboxId: "mb_vm", name: "vm", machineId: device.id, machineWorkspaceId: "ws_vm", own: false }];

  assert.deepEqual(await deliverMail(object.env, { jobMailboxes: boxes }, line), ["vm"]);
  assert.deepEqual(object.names, ["workspace:ws_vm"]);
  const frame = server.last();
  assert.equal(frame.type, "mail");
  assert.equal(frame.text, "Did the API types move?");
  assert.equal(protocol.parseServerFrame(JSON.stringify(frame)).ok, true);
});

test("a device in another workspace's object is not reached through this one", async () => {
  const world = machineWorld({ workspaceId: "ws_vm" });
  const device = await world.add("mch_vm", { mailOnly: true, expiresAt: world.clock.at + 86_400_000, folders: [] });
  const server = await world.connect(device);
  const object = objectFor(world);
  // The object already belongs to ws_vm; a call naming another workspace is refused there.
  await deliverMail(object.env, { jobMailboxes: async () => [{ mailboxId: "mb_vm", name: "vm", machineId: device.id, machineWorkspaceId: "ws_vm", own: false }] }, line);
  const sentBefore = server.sent.length;
  const other = await deliverMail(object.env, { jobMailboxes: async () => [{ mailboxId: "mb_x", name: "vm", machineId: device.id, machineWorkspaceId: "ws_other", own: false }] }, line);
  assert.deepEqual(other, []);
  assert.equal(server.sent.length, sentBefore);
});

const mailFrame = (n, at) => ({ messageId: `ml_mb_vm_${n}`, kind: "note", from: "lead", to: "vm", text: `line ${n}`, path: "projects/a.md", at });

test("mail sent while a device reconnects reaches it when it is back", async () => {
  const world = machineWorld({ workspaceId: "ws_vm" });
  const device = await world.add("mch_vm", { mailOnly: true, expiresAt: world.clock.at + 86_400_000, folders: [] });
  const first = await world.connect(device);
  // Sent on a socket that already died without closing: the send looked fine, the runner never got it.
  assert.equal((await world.call("ws.machine.mail", { id: device.id, mail: mailFrame(1, world.clock.at) })).sent, true);
  world.sockets.closed(first);
  // Sent while no socket is open.
  assert.equal((await world.call("ws.machine.mail", { id: device.id, mail: mailFrame(2, world.clock.at) })).sent, false);
  const second = await world.connect(device);
  const replayed = second.sent.filter((frame) => frame.type === "mail").map((frame) => frame.text);
  assert.deepEqual(replayed, ["line 1", "line 2"]);
  assert.ok(second.sent.findIndex((frame) => frame.type === "welcome") < second.sent.findIndex((frame) => frame.type === "mail"), "after the welcome");
});

test("only recent mail is handed over again, and none once the device is gone", async () => {
  const world = machineWorld({ workspaceId: "ws_vm" });
  const device = await world.add("mch_vm", { mailOnly: true, expiresAt: world.clock.at + 86_400_000, folders: [] });
  await world.call("ws.machine.mail", { id: device.id, mail: mailFrame(1, world.clock.at) });
  world.clock.at += 11 * 60 * 1000;
  await world.call("ws.machine.mail", { id: device.id, mail: mailFrame(2, world.clock.at) });
  const back = await world.connect(device);
  assert.deepEqual(back.sent.filter((frame) => frame.type === "mail").map((frame) => frame.text), ["line 2"]);

  // A full machine's sessions do not join mail as it: nothing is kept for it.
  const full = await world.add("mch_mac");
  await world.call("ws.machine.mail", { id: full.id, mail: mailFrame(3, world.clock.at) });
  assert.equal(world.machines.heldMail(full.id).length, 0);

  await world.call("ws.machine.remove", { id: device.id, reason: "left" });
  assert.equal(world.machines.heldMail(device.id).length, 0);
});
