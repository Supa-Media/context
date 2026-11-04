/**
 * Note mail to a mail-only device, end to end on the gateway side: `deliverMail` hands the line to the device's own
 * workspace object through the object's real entry (`serveWorkspaceStore`), as production does, and the frame goes
 * down the runner's socket.
 *
 * The 2026-11-04 live check from a cloud VM found the line never left the gateway: the call named no workspace, so the
 * object refused it before it reached the machine, and `machineMailOnly.test.mjs` did not see it because its stub
 * answered with `serveMachineCall` directly, past that check. This one goes through the object's front door.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `toMachine` without `workspaceId` in its call → "a line sent to a device reaches its runner's socket".
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
