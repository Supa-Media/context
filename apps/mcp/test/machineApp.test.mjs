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
 *  6. `assign` trusting a caller's `approved` → "only its own owner answers Ask me first".
 *  5. `answerAsk` accepting the workspace's owner → "only its own owner answers Ask me first".
 *  7. `raise` skipping `runsMachine` → "more time today is the computer's runner's, and lasts the day".
 *  8. `namedAsks` keeping the chat's key → "an ask names who asked, never the chat's key".
 *  4. `ownComputer` accepting the workspace's owner → "only a computer's own owner lends it to a group chat".
 *  9. the missing-workspace default dropped → "the Mac app, naming no workspace, changes its own computer's folders in the session's workspace".
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
    async texMachineChatPeople(userId, groupKey) {
      // Mirrors `chatPeopleAs`: only one of the chat's people gets them.
      const people = [{ userId: "user_owner", handle: "seyi" }, { userId: "user_ade", handle: "ade" }];
      return groupKey === CHAT && people.some((person) => person.userId === userId) ? people : null;
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

test("only its own owner answers Ask me first", async () => {
  const { ask, w } = await setup();
  await w.call("ws.machine.set", { id: "mch_1", patch: { chats: { [KEY]: { who: "everyone" } } } });
  const waiting = await w.call("ws.machine.assign", { machineId: "mch_1", jobId: "job_1", part: 1, chat: KEY, askerId: "user_ade", fromOwner: false, tool: "claude", folder: "/srv/code", permission: "edits", brief: "Fix it.", doneWhen: "" });
  assert.equal(waiting.code, "ask_first");
  // The object keeps the yes itself: a caller saying it was given is not one.
  assert.equal((await w.call("ws.machine.assign", { machineId: "mch_1", jobId: "job_1", part: 1, chat: KEY, askerId: "user_ade", fromOwner: false, approved: true, tool: "claude", folder: "/srv/code", permission: "edits", brief: "Fix it.", doneWhen: "" })).code, "ask_first");
  const body = { workspaceId: "ws_team", machineId: "mch_1", askId: waiting.askId, yes: true };
  assert.deepEqual((await ask("/machines/app/answer", body, app("user_boss", "owner"))).body, { ok: false, code: "unknown_machine" });
  assert.equal(w.machines.pendingAsks("mch_1").length, 1);
  assert.equal((await ask("/machines/app/answer", body, app("user_owner", "editor"))).body.ok, true);
  assert.equal(w.machines.pendingAsks("mch_1").length, 0);
  // Answered once: a second answer finds nothing waiting.
  assert.deepEqual((await ask("/machines/app/answer", body, app("user_owner", "editor"))).body, { ok: false, code: "unknown_ask" });
});

const assignAsk = (fields = {}) => ({ machineId: "mch_1", jobId: "job_1", part: 1, chat: KEY, askerId: "user_ade", fromOwner: false, tool: "claude", folder: "/srv/code", permission: "edits", brief: "Fix it.", doneWhen: "", ...fields });

test("an ask names who asked, never the chat's key", async () => {
  const { ask, w } = await setup();
  await w.call("ws.machine.set", { id: "mch_1", patch: { chats: { [KEY]: { who: "everyone" } } } });
  await w.call("ws.machine.assign", assignAsk({ chatKey: CHAT }));
  const [mine] = (await ask("/machines/app/list", { workspaceId: "ws_team" }, app("user_owner", "editor"))).body.machines;
  assert.equal(mine.asks.length, 1);
  assert.equal(mine.asks[0].askerHandle, "ade");
  assert.equal(JSON.stringify(mine.asks).includes(CHAT), false);
  // Somebody who doesn't run it sees no asks at all.
  const [theirs] = (await ask("/machines/app/list", { workspaceId: "ws_team" }, app("user_member", "member"))).body.machines;
  assert.equal(theirs.asks, undefined);
});

test("a chat's people come with their ids, only for one of them", async () => {
  const { ask } = await setup();
  assert.deepEqual((await ask("/machines/app/chat-people", { chat: CHAT }, app("user_owner", "editor"))).body, { ok: true, people: [{ userId: "user_owner", handle: "seyi" }, { userId: "user_ade", handle: "ade" }] });
  assert.deepEqual((await ask("/machines/app/chat-people", { chat: CHAT }, app("user_member", "member"))).body, { ok: false, code: "unknown_chat" });
});

test("more time today is the computer's runner's, and lasts the day", async () => {
  const { ask, w, server } = await setup();
  await w.call("ws.machine.set", { id: "mch_1", patch: { limits: { dayMs: 0 } } });
  const own = assignAsk({ askerId: "user_owner", fromOwner: true, chat: "texts-user_owner", grant: { token: "cat_run_000000000000", expiresAt: w.clock.at + 60_000, mcpUrl: "https://mcp.example.test/mcp" }, deadline: w.clock.at + 60_000 });
  assert.equal((await w.call("ws.machine.assign", own)).code, "limit_day");
  assert.deepEqual((await ask("/machines/app/raise", { workspaceId: "ws_team", machineId: "mch_1", minutes: 120 }, app("user_editor", "editor"))).body, { ok: false, code: "unknown_machine" });
  const raised = await ask("/machines/app/raise", { workspaceId: "ws_team", machineId: "mch_1", minutes: 120 }, app("user_owner", "editor"));
  assert.equal(raised.body.ok, true);
  assert.equal(server.last().type, "rules");
  assert.equal(server.last().rules.limits.dayMs, 120 * 60_000);
  assert.equal((await w.call("ws.machine.assign", own)).ok, true);
  // Tomorrow it is gone, and the daily limit itself never changed.
  w.clock.at += 24 * 60 * 60 * 1000;
  assert.equal(w.machines.get("mch_1").limits.dayMs, 0);
  // (The socket has long gone by then: the limit is read as if it were online.)
  assert.deepEqual(w.machines.admit("mch_1", { chat: "texts-user_owner", fromOwner: true, askerId: "user_owner", tool: "claude", folder: "/srv/code" }, true), { code: "limit_day" });
  assert.equal((await ask("/machines/app/raise", { workspaceId: "ws_team", machineId: "mch_1", minutes: 0 }, app("user_owner", "editor"))).status, 400);
});

test("the Mac app, naming no workspace, changes its own computer's folders in the session's workspace", async () => {
  const { ask } = await setup();
  const changed = await ask("/machines/app/set", { machineId: "mch_1", patch: { folders: ["/Users/a/Code"] } }, app("user_owner", "owner"));
  assert.equal(changed.body.ok, true);
  assert.deepEqual(changed.body.machine.folders, ["/Users/a/Code"]);
  // The default is still checked as membership: a session no longer a live member of its own workspace reaches nothing.
  const left = app("user_owner", "owner", { workspaces: [] });
  assert.deepEqual((await ask("/machines/app/set", { machineId: "mch_1", patch: { folders: ["/x"] } }, left)).body, { ok: false, code: "unknown_machine" });
  // And another person's session, defaulting to its own workspace, can't name this one's computer.
  const ade = app("user_ade", "editor");
  assert.deepEqual((await ask("/machines/app/set", { machineId: "mch_1", patch: { folders: ["/x"] } }, ade)).body, { ok: false, code: "unknown_machine" });
});
