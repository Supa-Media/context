// The app's live file tree from the workspace object (src/workspaceStore/
// listing.js, treeSockets.js; src/live/treeRoute.js): each watched folder
// listed at the socket's own clearance, a withheld folder answering as an
// absent one, a change nobody may see sending nothing, and a reader the
// client can never name.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { listFolderFromRows, folderPathOf } from "../src/workspaceStore/listing.js";
import { treeSockets, readerOf, TREE_READER_HEADER } from "../src/workspaceStore/treeSockets.js";
import { treeRows } from "../src/workspaceStore/treeRows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { handleTree } from "../src/live/treeRoute.js";
import { handleWorkspaceStoreDoor } from "../src/workspaceStore/door.js";
import { isTransportPath } from "../src/origin.js";
import { decodeClientFrame, decodeServerFrame, TREE_CLOSE_NOT_SERVED, TREE_CLOSE_REAUTH, TREE_SOCKET_PATH } from "../../../packages/shared/src/treeFrames.cjs";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function durableSql() {
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

const RULES = (accessVersion = 1, extra = {}) => ({
  etag: `m.${accessVersion}`,
  accessVersion,
  folders: [
    { prefix: "projects", visibility: "team" },
    { prefix: "projects/secret", visibility: "private" },
    ...(extra.folders ?? []),
  ],
  notes: [
    { path: "projects/plan-private.md", visibility: "private" },
    { path: "projects/for-design.md", visibility: "@design" },
    ...(extra.notes ?? []),
  ],
});

let clock = 1;
const row = (id, path, kind = "file", more = {}) => ({ id, path, kind, at: clock++, ...more });
const ROWS = () => [
  row("f1", "projects", "folder", { role: "projects" }),
  row("f2", "projects/secret", "folder"),
  row("f3", "areas", "folder"),
  row("n1", "projects/plan.md", "file", { size: 10, uploaded: 1000 }),
  row("n2", "projects/plan-private.md"),
  row("n3", "projects/for-design.md"),
  row("n4", "projects/secret/rates.md"),
  row("n5", "todo.md"),
];

function world({ home = "object", rules = RULES() } = {}) {
  const sql = durableSql();
  const store = { objects: texObjects(sql), rows: workspaceRows(sql) };
  store.rows.pinWorkspace("w1");
  store.rows.put(ROWS());
  if (rules !== null) store.rows.putRules(rules);
  store.rows.setHome(home);
  return { sql, store };
}

const TEAM = { scope: "team", names: new Set() };
const OWNER = { scope: "private", names: new Set() };
const DESIGN = { scope: "team", names: new Set(["@design"]) };

function listing(store, sql, folder, clearance) {
  const tree = treeRows(sql);
  const { rows: children, more } = tree.children(folder);
  return listFolderFromRows({ folder, clearance, held: store.rows.rules("member"), children, more, own: tree.own(folder), roots: tree.jobRows() });
}
const names = (page) => page.entries.map((entry) => entry.path);

test("a team member's listing never names a private note, and a group note only for its group", { skip }, () => {
  const { store, sql } = world();
  assert.deepEqual(names(listing(store, sql, "projects", TEAM)), ["projects/plan.md"]);
  assert.deepEqual(names(listing(store, sql, "projects", DESIGN)), ["projects/for-design.md", "projects/plan.md"]);
  assert.deepEqual(names(listing(store, sql, "projects", OWNER)), [
    "projects/secret",
    "projects/for-design.md",
    "projects/plan-private.md",
    "projects/plan.md",
  ]);
});

test("a withheld folder answers exactly as a folder that is not there", { skip }, () => {
  const { store, sql } = world();
  const secret = listing(store, sql, "projects/secret", TEAM);
  const absent = listing(store, sql, "projects/nothing-here", TEAM);
  assert.deepEqual({ ...secret, path: "x" }, { ...absent, path: "x" });
  assert.equal(secret.entries.length, 0);
  // Deeper still: the default printed is the nearest visible ancestor's, never the private folder's own.
  assert.equal(listing(store, sql, "projects/secret/deeper", TEAM).folderDefault, listing(store, sql, "projects/guess/deeper", TEAM).folderDefault);
});

test("an object holding no rules shows nothing, failing closed", { skip }, () => {
  const { store, sql } = world({ rules: null });
  for (const clearance of [TEAM, OWNER]) {
    const page = listing(store, sql, "", clearance);
    assert.deepEqual(page.entries, []);
    assert.equal(page.manifestUsable, false);
  }
});

test("the root draws folders by job and order, with each folder's job and own job", { skip }, () => {
  const { store, sql } = world();
  const root = listing(store, sql, "", OWNER);
  assert.deepEqual(names(root), ["projects", "areas", "todo.md"]);
  assert.equal(root.entries[0].role, "projects");
  assert.equal(root.entries[1].role, "areas", "a root folder's job comes from its name when its row has none");
  assert.equal(listing(store, sql, "projects", OWNER).role, "projects");
  const plan = listing(store, sql, "projects", TEAM).entries[0];
  assert.equal(plan.size, 10);
  assert.equal(plan.updatedAt, 1000);
});

test("a folder path that climbs or is malformed is not watched", () => {
  assert.equal(folderPathOf("../x"), null);
  assert.equal(folderPathOf("a//b"), null);
  assert.equal(folderPathOf("/projects/"), "projects");
  assert.equal(folderPathOf(""), "");
});

/* ------------------------------- the sockets ------------------------------- */

function fakeSocket() {
  const socket = {
    sent: [],
    closed: null,
    readyState: 1,
    attachment: null,
    send(frame) {
      this.sent.push(JSON.parse(frame));
    },
    close(code, reason) {
      this.closed = { code, reason };
      this.readyState = 3;
    },
    serializeAttachment(value) {
      this.attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
  return socket;
}

function socketWorld(options) {
  const { store, sql } = world(options);
  const accepted = [];
  const state = { acceptWebSocket: (ws) => accepted.push(ws), getWebSockets: () => accepted.filter((ws) => ws.readyState === 1) };
  let now = 1_000_000;
  const tree = treeSockets(state, sql, store, {
    now: () => now,
    pair: () => [fakeSocket(), fakeSocket()],
    schedule: () => {},
    upgraded: (client) => ({ status: 101, webSocket: client }),
  });
  store.onTreeChange = (change) => tree.changed(change);
  const open = (reader) => {
    const response = tree.accept(new Request("https://x/tree", { headers: { [TREE_READER_HEADER]: JSON.stringify(reader) } }));
    return { response, server: accepted[accepted.length - 1] };
  };
  const call = async (op, fields) =>
    await serveWorkspaceStore(store, new Request("https://x/", {
      method: "POST",
      headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) },
      body: JSON.stringify({ ...fields, workspaceId: "w1" }),
    }));
  return { store, sql, tree, open, call, advance: (ms) => (now += ms), now: () => now };
}

const reader = (scope, groups = [], deadline = 2_000_000) => ({ scope, groups, deadline });

test("a watched folder is listed at the socket's clearance, and listed again only when it changed for that socket", { skip }, async () => {
  const w = socketWorld();
  const team = w.open(reader("team")).server;
  const owner = w.open(reader("private")).server;
  await w.tree.message(team, JSON.stringify({ t: "watch", folders: ["projects"] }));
  await w.tree.message(owner, JSON.stringify({ t: "watch", folders: ["projects"] }));
  assert.deepEqual(names(team.sent[0].page), ["projects/plan.md"]);
  assert.equal(owner.sent[0].page.entries.length, 4);

  // A private note is added: the owner hears of it, the team member hears nothing at all.
  await w.call("ws.rows.put", { rows: [row("n9", "projects/plan-private.md.bak", "file")] });
  await w.call("ws.rules.put", { rules: RULES(2, { notes: [{ path: "projects/plan-private.md.bak", visibility: "private" }] }) });
  await w.tree.flush();
  assert.equal(team.sent.length, 1, "a change the reader may not see sends that reader no frame");
  assert.equal(owner.sent.length, 2);
  assert.ok(names(owner.sent[1].page).includes("projects/plan-private.md.bak"));

  // A team note is added: both hear of it.
  await w.call("ws.rows.put", { rows: [row("n10", "projects/notes.md", "file")] });
  await w.tree.flush();
  assert.deepEqual(names(team.sent[1].page), ["projects/notes.md", "projects/plan.md"]);
});

test("a note moved out of a watched folder is listed again in both folders", { skip }, async () => {
  const w = socketWorld();
  const owner = w.open(reader("private")).server;
  await w.tree.message(owner, JSON.stringify({ t: "watch", folders: ["projects", "areas"] }));
  owner.sent.length = 0;
  await w.call("ws.rows.put", { rows: [row("n1", "areas/plan.md", "file")] });
  await w.tree.flush();
  const folders = owner.sent.map((frame) => frame.folder).sort();
  assert.deepEqual(folders, ["areas", "projects"]);
});

test("a socket past its deadline is closed to be authorized again", { skip }, async () => {
  const w = socketWorld();
  const socket = w.open(reader("team", [], 1_000_500)).server;
  w.advance(1_000);
  await w.tree.message(socket, JSON.stringify({ t: "ping" }));
  assert.equal(socket.closed.code, TREE_CLOSE_REAUTH);
  assert.equal(socket.sent.length, 0);
});

test("a workspace not read from its object says not_served, and one switched back closes its sockets", { skip }, async () => {
  const bucket = socketWorld({ home: "bucket" }).open(reader("team")).server;
  assert.deepEqual(bucket.sent, [{ t: "not_served" }]);
  assert.equal(bucket.closed.code, TREE_CLOSE_NOT_SERVED);

  const w = socketWorld();
  const socket = w.open(reader("team")).server;
  await w.tree.message(socket, JSON.stringify({ t: "watch", folders: [""] }));
  w.store.rows.setHome("dual");
  w.tree.notice({ all: true });
  await w.tree.flush();
  assert.deepEqual(socket.sent.at(-1), { t: "not_served" });
  assert.equal(socket.closed.code, TREE_CLOSE_NOT_SERVED);
});

test("a reader the gateway did not write is refused, and a bad frame closes the socket", { skip }, async () => {
  assert.equal(readerOf("{}"), null);
  assert.equal(readerOf(JSON.stringify({ scope: "owner", groups: [], deadline: 1 })), null);
  assert.equal(readerOf(JSON.stringify({ scope: "team", groups: "x", deadline: 1 })), null);
  const w = socketWorld();
  assert.equal(w.tree.accept(new Request("https://x/tree")).status, 400);
  const socket = w.open(reader("team")).server;
  await w.tree.message(socket, "not json");
  assert.equal(socket.closed.code, 1008);
  assert.equal(decodeClientFrame(JSON.stringify({ t: "watch", folders: Array.from({ length: 41 }, (_, i) => `f${i}`) })), null);
});

test("frames read the same on both sides", () => {
  assert.deepEqual(decodeServerFrame(JSON.stringify({ t: "listing", folder: "a", page: { path: "a", entries: [] } })), { t: "listing", folder: "a", page: { path: "a", entries: [] } });
  assert.equal(decodeServerFrame(JSON.stringify({ t: "listing", folder: "a" })), null);
  assert.equal(decodeServerFrame("{"), null);
});

/* -------------------------------- the route -------------------------------- */

const TOKEN = `cat_console_${"0".repeat(24)}`;
const session = (role = "member", grantedNames = []) => ({
  grantId: "grant_1",
  clientId: "context_console",
  actorUserId: "user_1",
  scopes: ["context:read", "context:write", "context:private"],
  defaultWorkspaceId: "w1",
  workspaces: [{ workspaceId: "w1", slug: "studio", role, kind: "shared", grantedNames }],
  expiresAt: Date.now() + 60 * 60_000,
});

function routeWorld(resolved) {
  const forwarded = [];
  const env = {
    WORKSPACE_STORE: {
      idFromName: (name) => ({ name }),
      get: (id) => ({
        fetch: async (request) => {
          forwarded.push({ name: id.name, request });
          return { status: 101, headers: new Headers(), webSocket: "client" };
        },
      }),
    },
  };
  const deps = { controlPlane: { resolveSession: async () => resolved }, upgraded: (headers, webSocket) => ({ status: 101, headers, webSocket }) };
  const ask = (headers = {}) =>
    handleTree(
      new Request("https://gateway/presence/tree", {
        headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `context.tree, context.token.${TOKEN}`, ...headers },
      }),
      env,
      { slug: null, pathToken: null, origin: null },
      deps,
    );
  return { env, ask, forwarded };
}

test("the tree route opens the grant's workspace with a reader it wrote itself, never the client's", async () => {
  const { ask, forwarded } = routeWorld(session("member", ["design"]));
  const forged = JSON.stringify({ scope: "private", groups: ["@everyone"], deadline: 9e15 });
  const response = await ask({ [TREE_READER_HEADER]: forged, "x-tex-call": "x" });
  assert.equal(response.status, 101);
  assert.equal(response.headers.get("Sec-WebSocket-Protocol"), "context.tree", "the token offered beside it is never echoed");
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].name, "workspace:w1");
  const sent = forwarded[0].request.headers;
  const named = JSON.parse(sent.get(TREE_READER_HEADER));
  assert.equal(named.scope, "team", "a member reads at team scope whatever the client claims");
  assert.deepEqual(named.groups, ["@design"]);
  assert.ok(named.deadline <= Date.now() + 5 * 60_000);
  assert.equal(sent.get("x-tex-call"), null);
  assert.equal(sent.get("Sec-WebSocket-Protocol"), null, "the token never crosses into the object");
});

test("the tree route refuses no token, a read-less grant, a guest's names, and a plain GET", async () => {
  const none = await routeWorld(null).ask();
  assert.equal(none.status, 401);
  const readless = await routeWorld({ ...session(), scopes: ["context:write"] }).ask();
  assert.equal(readless.status, 403);
  const guest = await routeWorld(session("member", ["#reads-as-guest"])).ask();
  assert.equal(guest.status, 403);
  const { env } = routeWorld(session());
  const plain = await handleTree(new Request("https://gateway/presence/tree"), env, { slug: null, pathToken: null, origin: null });
  assert.equal(plain.status, 426);
  const unbound = await handleTree(new Request("https://gateway/presence/tree", { headers: { Upgrade: "websocket" } }), {}, { slug: null, pathToken: null, origin: null });
  assert.equal(unbound.status, 501);
});

test("the tree socket is origin-checked, as every socket a browser can open", () => {
  assert.equal(isTransportPath(TREE_SOCKET_PATH), true);
});

test("the control plane's door never forwards an upgrade or a reader to a workspace object", async () => {
  const seen = [];
  const env = {
    GATEWAY_SECRET: "s".repeat(32),
    WORKSPACE_STORE: { idFromName: (name) => ({ name }), get: () => ({ fetch: async (request) => (seen.push(request), Response.json({})) }) },
  };
  const request = new Request("https://gateway/internal/workspace-store", {
    method: "POST",
    headers: {
      authorization: `Bearer ${"s".repeat(32)}`,
      "x-gateway-secret": "s".repeat(32),
      "x-workspace-ticket": "ticket",
      "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.state" })),
      Upgrade: "websocket",
      [TREE_READER_HEADER]: JSON.stringify(reader("private")),
    },
    body: "{}",
  });
  const response = await handleWorkspaceStoreDoor(request, env, { controlPlane: { openTexStoreTicket: async () => ({ workspaceId: "w1", owners: [] }) } });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get("Upgrade"), null);
  assert.equal(seen[0].headers.get(TREE_READER_HEADER), null);
});

test("a socket that went without a close event leaves no rows behind once another opens", { skip }, async () => {
  const w = socketWorld();
  const gone = w.open(reader("team")).server;
  await w.tree.message(gone, JSON.stringify({ t: "watch", folders: ["projects"] }));
  gone.readyState = 3;
  w.open(reader("team"));
  const held = w.sql.exec("SELECT COUNT(*) AS n FROM ws_tree_watch").toArray()[0].n;
  assert.equal(held, 0);
  assert.equal(w.sql.exec("SELECT COUNT(*) AS n FROM ws_tree_sockets").toArray()[0].n, 1);
});

test("the socket's path reaches the route: it is never read as a workspace's name", async () => {
  // Shipped as a bare `/tree` first, which read as the workspace called `tree` and answered 404 in production.
  const { splitWorkspacePath } = await import("../src/workspacePath.js");
  assert.deepEqual(splitWorkspacePath(TREE_SOCKET_PATH), { slug: null, path: TREE_SOCKET_PATH });
  assert.deepEqual(splitWorkspacePath(`/@studio${TREE_SOCKET_PATH}`), { slug: "studio", path: TREE_SOCKET_PATH });
  // And through the gateway's own router: no token is the route's 401, never the 404 a workspace path gets.
  const { route } = await import("../src/http/route.js");
  const env = { WORKSPACE_STORE: { idFromName: (name) => ({ name }), get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) } };
  const answer = await route(new Request(`https://gateway.test${TREE_SOCKET_PATH}`, { headers: { Upgrade: "websocket" } }), env, { waitUntil() {} });
  assert.equal(answer.status, 401);
});

/* ------------------------- the reader as a member ------------------------- */

const MEMBER = { userId: "user_a", personalWorkspaceId: "ws_pa", role: "editor", groups: [], at: 1 };

/** A socket world whose object also keeps its members (`store.members`, read by `clearanceOf` when home is `object`). */
function memberSocketWorld({ home = null } = {}) {
  const w = socketWorld();
  w.store.members = workspaceMembers(w.sql);
  if (home !== null) w.store.members.setHome(home);
  return w;
}

test("readerOf keeps a well-formed userId and refuses a malformed or non-string one", () => {
  const kept = readerOf(JSON.stringify({ scope: "team", groups: [], deadline: 1, userId: "user_a" }));
  assert.equal(kept.userId, "user_a");
  const anonymous = readerOf(JSON.stringify({ scope: "team", groups: [], deadline: 1 }));
  assert.equal("userId" in anonymous, false, "a reader that names nobody carries no userId");
  assert.equal(readerOf(JSON.stringify({ scope: "team", groups: [], deadline: 1, userId: "a/b" })), null);
  assert.equal(readerOf(JSON.stringify({ scope: "team", groups: [], deadline: 1, userId: 5 })), null);
  assert.equal(readerOf(JSON.stringify({ scope: "team", groups: [], deadline: 1, userId: {} })), null);
});

test("with home convex a socket that names no one is listed as before", { skip }, async () => {
  const w = memberSocketWorld();
  const socket = w.open(reader("team")).server;
  await w.tree.message(socket, JSON.stringify({ t: "watch", folders: ["projects"] }));
  assert.equal(socket.closed, null);
  assert.deepEqual(names(socket.sent[0].page), ["projects/plan.md"]);
});

test("with home object a socket whose reader is a live member is listed at its clearance", { skip }, async () => {
  const w = memberSocketWorld({ home: "object" });
  w.store.members.put("members", [MEMBER]);
  const socket = w.open({ ...reader("team"), userId: "user_a" }).server;
  await w.tree.message(socket, JSON.stringify({ t: "watch", folders: ["projects"] }));
  assert.equal(socket.closed, null);
  assert.deepEqual(names(socket.sent[0].page), ["projects/plan.md"]);
});

test("with home object a socket that names no one, or a non-member, is closed to reauthorize and gets no listing", { skip }, async () => {
  const w = memberSocketWorld({ home: "object" });
  w.store.members.put("members", [MEMBER]);
  const anonymous = w.open(reader("team")).server;
  await w.tree.message(anonymous, JSON.stringify({ t: "watch", folders: ["projects"] }));
  assert.equal(anonymous.closed.code, TREE_CLOSE_REAUTH);
  assert.equal(anonymous.sent.length, 0);

  const stranger = w.open({ ...reader("team"), userId: "user_x" }).server;
  await w.tree.message(stranger, JSON.stringify({ t: "watch", folders: ["projects"] }));
  assert.equal(stranger.closed.code, TREE_CLOSE_REAUTH);
  assert.equal(stranger.sent.length, 0);
});

test("with home object a member removed from the workspace loses its open socket on the next change, and no new listing", { skip }, async () => {
  const w = memberSocketWorld({ home: "object" });
  w.store.members.put("members", [MEMBER]);
  const socket = w.open({ ...reader("team"), userId: "user_a" }).server;
  await w.tree.message(socket, JSON.stringify({ t: "watch", folders: ["projects"] }));
  assert.equal(socket.sent.length, 1);

  assert.deepEqual(w.store.members.remove("members", ["user_a"], 5), ["user_a"]);
  w.tree.changed({ paths: null });
  await w.tree.flush();
  assert.equal(socket.closed.code, TREE_CLOSE_REAUTH);
  assert.equal(socket.sent.length, 1, "no listing is sent once the reader is no longer a member");
  assert.equal(w.sql.exec("SELECT COUNT(*) AS n FROM ws_tree_sockets").toArray()[0].n, 0);

  // A fresh socket for the removed person is refused on its first watch too.
  const again = w.open({ ...reader("team"), userId: "user_a" }).server;
  await w.tree.message(again, JSON.stringify({ t: "watch", folders: ["projects"] }));
  assert.equal(again.closed.code, TREE_CLOSE_REAUTH);
  assert.equal(again.sent.length, 0);
});
