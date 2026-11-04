/**
 * The app's screens for a person's own computers (`machines/appRoutes.js`):
 * only the app's own session reaches them, a computer's settings are seen and
 * changed only by whoever runs it (its owner or the workspace's owner), and
 * Disconnect revokes its grant and closes its socket at once.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `runsMachine` letting a shared workspace's editor in → "another editor can't open somebody else's computer to themselves".
 *  2. `disconnect` skipping `ws.machine.remove` → "disconnect revokes the grant and says goodbye on the socket at once".
 *  3. `list` showing every member the full row → "a member who doesn't run a computer sees only its name and whether it is online".
 *  4. `ownComputer` accepting the workspace's owner → "only a computer's own owner lends it to a group chat".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { handleMachineApp } from "../src/machines/appRoutes.js";
import { serveMachineCall } from "../src/workspaceStore/serveMachines.js";
import { opOf } from "../src/texStore/move.js";
import { machineWorld } from "./machineWorld.mjs";

const ORIGIN = "https://mcp.example.test";

function setupWorld() {
  const w = machineWorld({ workspaceId: "ws_team" });
  const namespace = {
    idFromName: (name) => name,
    get: () => ({
      async fetch(request) {
        return await serveMachineCall({ machines: w.machines, machineSockets: w.sockets }, opOf(request), JSON.parse(await request.text()));
      },
    }),
  };
  const revoked = [];
  const lent = [];
  const controlPlane = {
    lent,
    // Mirrors `attachTexMachineToChat`: the computer's own owner, one of the chat's people.
    async texMachineChatAttach(userId, machineId, groupKey) {
      if (userId !== "user_owner") return { refused: 404 };
      if (!lent.some((entry) => entry.machineId === machineId && entry.groupKey === groupKey)) lent.push({ userId, machineId, groupKey });
      return { attached: true, workspaceId: "ws_team" };
    },
    async texMachineChatDetach(userId, machineId, groupKey) {
      if (userId !== "user_owner") return null;
      const at = lent.findIndex((entry) => entry.machineId === machineId && entry.groupKey === groupKey);
      if (at >= 0) lent.splice(at, 1);
      return { detached: at >= 0 };
    },
    // Mirrors `revokeMachineAs`: its owner or the workspace's owner.
    async texMachineRevoke(machineId, userId) {
      if (userId !== "user_owner" && userId !== "user_boss") return null;
      revoked.push({ machineId, userId });
      return { revoked: true, workspaceId: "ws_team" };
    },
  };
  return { w, env: { WORKSPACE_STORE: namespace }, controlPlane, revoked };
}

const app = (userId, role, fields = {}) => ({ actorClientId: "context_console", actorUserId: userId, scopes: ["context:read", "context:write"], workspaceId: "ws_team", workspaces: [{ workspaceId: "ws_team", slug: "devs", role, kind: "shared" }], ...fields });

async function setup() {
  const world = setupWorld();
  const machine = await world.w.add("mch_1");
  const server = await world.w.connect(machine);
  const ask = async (path, body, who) => {
    const response = await handleMachineApp(new Request(`${ORIGIN}${path}`, { method: "POST", body: JSON.stringify(body) }), world.env, who, { path, controlPlane: world.controlPlane });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { ...world, server, ask };
}

test("only the app's own session reaches these routes, and changing anything needs write", async () => {
  const { ask } = await setup();
  for (const who of [app("user_owner", "owner", { actorClientId: "context_texts" }), app("user_owner", "owner", { actorClientId: "some_ai_client" })]) {
    assert.equal((await ask("/machines/app/list", { workspaceId: "ws_team" }, who)).status, 403);
  }
  assert.equal((await ask("/machines/app/set", { workspaceId: "ws_team", machineId: "mch_1", patch: { name: "x" } }, app("user_owner", "owner", { scopes: ["context:read"] }))).status, 403);
});

test("the computer's owner sees and changes its settings, and the runner is told the new rules", async () => {
  const { ask, server } = await setup();
  const listed = (await ask("/machines/app/list", { workspaceId: "ws_team" }, app("user_owner", "editor"))).body;
  assert.equal(listed.machines[0].runs, true);
  assert.deepEqual(listed.machines[0].folders, ["/srv/code"]);
  assert.equal(listed.machines[0].publicKey, undefined);
  const changed = await ask("/machines/app/set", { workspaceId: "ws_team", machineId: "mch_1", patch: { name: "Studio Mac", folders: ["/srv/code", "/srv/web"] } }, app("user_owner", "editor"));
  assert.equal(changed.body.ok, true);
  assert.equal(changed.body.machine.name, "Studio Mac");
  assert.equal(server.last().type, "rules");
  // A key that is not a setting is refused, not ignored.
  assert.deepEqual((await ask("/machines/app/set", { workspaceId: "ws_team", machineId: "mch_1", patch: { ownerId: "user_editor" } }, app("user_owner", "editor"))).body, { ok: false, code: "bad_setting" });
});

test("a member who doesn't run a computer sees only its name and whether it is online", async () => {
  const { ask } = await setup();
  const [seen] = (await ask("/machines/app/list", { workspaceId: "ws_team" }, app("user_member", "member"))).body.machines;
  assert.deepEqual(Object.keys(seen).sort(), ["id", "name", "online", "os", "ownerId"]);
  assert.equal(seen.online, true);
});

test("another editor can't open somebody else's computer to themselves, nor disconnect it", async () => {
  const { ask, revoked, server } = await setup();
  const editor = app("user_editor", "editor");
  assert.deepEqual((await ask("/machines/app/set", { workspaceId: "ws_team", machineId: "mch_1", patch: { chats: { "texts-user_editor": { who: "everyone", askFirst: false } } } }, editor)).body, { ok: false, code: "unknown_machine" });
  assert.deepEqual((await ask("/machines/app/disconnect", { workspaceId: "ws_team", machineId: "mch_1" }, editor)).body, { ok: false, code: "unknown_machine" });
  assert.equal(revoked.length, 0);
  assert.notEqual(server.last()?.type, "goodbye");
  // The workspace's owner runs every computer in it.
  assert.equal((await ask("/machines/app/set", { workspaceId: "ws_team", machineId: "mch_1", patch: { goodAt: "Builds the iOS app" } }, app("user_boss", "owner"))).body.ok, true);
});

test("a workspace the session doesn't reach has no computers at all", async () => {
  const { ask } = await setup();
  const outsider = app("user_owner", "owner", { workspaces: [{ workspaceId: "ws_other", slug: "other", role: "owner", kind: "personal" }] });
  assert.deepEqual((await ask("/machines/app/list", { workspaceId: "ws_team" }, outsider)).body, { ok: false, code: "unknown_workspace" });
  assert.deepEqual((await ask("/machines/app/set", { workspaceId: "ws_team", machineId: "mch_1", patch: { name: "x" } }, outsider)).body, { ok: false, code: "unknown_machine" });
});

test("disconnect revokes the grant and says goodbye on the socket at once", async () => {
  const { ask, revoked, server, w } = await setup();
  const answer = await ask("/machines/app/disconnect", { workspaceId: "ws_team", machineId: "mch_1" }, app("user_owner", "editor"));
  assert.equal(answer.body.ok, true);
  assert.deepEqual(revoked, [{ machineId: "mch_1", userId: "user_owner" }]);
  assert.equal(server.last().type, "goodbye");
  assert.equal(w.machines.get("mch_1"), null);
});

const CHAT = "c".repeat(64);
const KEY = `group-${CHAT.slice(0, 58)}`;

test("its owner lends a computer to a group chat, Only me and Ask me first unless they say otherwise", async () => {
  const { ask, controlPlane, w, server } = await setup();
  const lent = await ask("/machines/app/lend", { workspaceId: "ws_team", machineId: "mch_1", chat: CHAT }, app("user_owner", "editor"));
  assert.equal(lent.body.ok, true);
  assert.deepEqual(controlPlane.lent, [{ userId: "user_owner", machineId: "mch_1", groupKey: CHAT }]);
  assert.equal(w.machines.get("mch_1").chats[KEY].who, "owner");
  assert.equal(w.machines.get("mch_1").chats[KEY].askFirst, true);
  assert.equal(server.last().type, "rules");
  await ask("/machines/app/lend", { workspaceId: "ws_team", machineId: "mch_1", chat: CHAT, who: "everyone", askFirst: false }, app("user_owner", "editor"));
  assert.deepEqual({ who: w.machines.get("mch_1").chats[KEY].who, askFirst: w.machines.get("mch_1").chats[KEY].askFirst }, { who: "everyone", askFirst: false });
  const back = await ask("/machines/app/unlend", { workspaceId: "ws_team", machineId: "mch_1", chat: CHAT }, app("user_owner", "editor"));
  assert.equal(back.body.ok, true);
  assert.deepEqual(controlPlane.lent, []);
  assert.equal(w.machines.get("mch_1").chats[KEY], undefined);
});

test("only a computer's own owner lends it to a group chat", async () => {
  const { ask, controlPlane, w } = await setup();
  for (const who of [app("user_boss", "owner"), app("user_editor", "editor")]) {
    assert.deepEqual((await ask("/machines/app/lend", { workspaceId: "ws_team", machineId: "mch_1", chat: CHAT, who: "everyone", askFirst: false }, who)).body, { ok: false, code: "unknown_machine" });
  }
  assert.deepEqual(controlPlane.lent, []);
  assert.equal(w.machines.get("mch_1").chats[KEY], undefined);
  assert.equal((await ask("/machines/app/lend", { workspaceId: "ws_team", machineId: "mch_1", chat: "not-a-key" }, app("user_owner", "editor"))).status, 400);
});
