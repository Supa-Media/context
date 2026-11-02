// The app's access socket (`GET /presence/access`): the frame codec both sides
// read (packages/shared/src/accessFrames.cjs), the gateway route that names the
// reader and picks the object (src/live/accessRoute.js), and the object side
// that serves topics and writes (src/workspaceStore/accessSockets.js). The
// dispatch between tree and access sockets is in src/workspaceStore.js.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCESS_PROTOCOL,
  ACCESS_SOCKET_MAX_MS,
  ACCESS_SOCKET_PATH,
  ACCESS_CLOSE_FORBIDDEN,
  ACCESS_CLOSE_NOT_SERVED,
  ACCESS_CLOSE_REAUTH,
  ackFrame,
  decodeClientFrame,
  decodeServerFrame,
  notServedFrame,
  pongFrame,
  refusedFrame,
  rowsFrame,
} from "../../../packages/shared/src/accessFrames.cjs";
import { accessSockets, accessReaderOf, ACCESS_READER_HEADER } from "../src/workspaceStore/accessSockets.js";
import { handleAccess, personalWorkspaceOf } from "../src/live/accessRoute.js";
import { isTransportPath } from "../src/origin.js";
import { splitWorkspacePath } from "../src/workspacePath.js";
import { route } from "../src/http/route.js";

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

/* ------------------------------ the codec ------------------------------ */

const frameOfLength = (total) => {
  const shell = '{"t":"ping","pad":""}';
  return shell.slice(0, -2) + "x".repeat(total - shell.length) + '"}';
};

test("a client frame is read only for the topics and writes its side answers", () => {
  // Workspace side: members and invites, and the workspace writes.
  assert.deepEqual(decodeClientFrame("workspace", JSON.stringify({ t: "sub", topics: ["members", "invites"] })), {
    t: "sub",
    topics: ["members", "invites"],
  });
  assert.equal(decodeClientFrame("workspace", JSON.stringify({ t: "sub", topics: ["connections"] })), null, "a person topic on the workspace side is refused");
  assert.equal(decodeClientFrame("person", JSON.stringify({ t: "sub", topics: ["members"] })), null, "a workspace topic on the person side is refused");
  assert.deepEqual(decodeClientFrame("workspace", JSON.stringify({ t: "op", id: "a1", op: "remove_member", args: { userId: "u2" } })), {
    t: "op",
    id: "a1",
    op: "remove_member",
    args: { userId: "u2" },
  });
  assert.equal(decodeClientFrame("person", JSON.stringify({ t: "op", id: "a1", op: "remove_member", args: {} })), null, "a workspace write on the person side is refused");
  assert.deepEqual(decodeClientFrame("person", JSON.stringify({ t: "op", id: "a2", op: "accept_invite" })), { t: "op", id: "a2", op: "accept_invite", args: {} }, "args default to an empty object");
  assert.deepEqual(decodeClientFrame("workspace", JSON.stringify({ t: "ping" })), { t: "ping" });
  assert.equal(decodeClientFrame("workspace", JSON.stringify({ t: "bogus" })), null);
  assert.equal(decodeClientFrame("admin", JSON.stringify({ t: "sub", topics: ["members"] })), null, "an unknown side reads no topic");
  assert.equal(decodeClientFrame("admin", JSON.stringify({ t: "op", id: "a", op: "invite" })), null, "an unknown side reads no write");
});

test("a client op is refused without a usable id, with args that are not an object, and when oversized", () => {
  const op = (fields) => JSON.stringify({ t: "op", op: "invite", ...fields });
  assert.equal(decodeClientFrame("workspace", op({})), null, "a missing id is refused");
  assert.equal(decodeClientFrame("workspace", op({ id: "" })), null, "an empty id is refused");
  assert.equal(decodeClientFrame("workspace", op({ id: 5 })), null, "a non-string id is refused");
  assert.equal(decodeClientFrame("workspace", op({ id: "x".repeat(65) })), null, "a 65-character id is refused");
  assert.equal(decodeClientFrame("workspace", op({ id: "x".repeat(64) })).id.length, 64, "a 64-character id is the limit");
  assert.equal(decodeClientFrame("workspace", op({ id: "a", args: [] })), null, "array args are refused");
  assert.equal(decodeClientFrame("workspace", op({ id: "a", args: null })), null, "null args are refused");
  assert.equal(decodeClientFrame("workspace", op({ id: "a", args: "x" })), null, "string args are refused");
  assert.equal(decodeClientFrame("workspace", frameOfLength(16 * 1024 + 1)), null, "a frame over 16KB is refused");
  assert.deepEqual(decodeClientFrame("workspace", frameOfLength(16 * 1024)), { t: "ping" }, "a frame of exactly 16KB is read");
  assert.equal(decodeClientFrame("workspace", "{not json"), null);
  assert.equal(decodeClientFrame("workspace", JSON.stringify([{ t: "ping" }])), null, "an array is not a frame");
});

test("a sub frame names each topic once", () => {
  assert.deepEqual(decodeClientFrame("workspace", JSON.stringify({ t: "sub", topics: ["members", "members", "invites"] })), {
    t: "sub",
    topics: ["members", "invites"],
  });
  assert.equal(decodeClientFrame("workspace", JSON.stringify({ t: "sub", topics: "members" })), null, "topics must be an array");
});

test("a server frame reads back as the object wrote it", () => {
  assert.deepEqual(decodeServerFrame("workspace", rowsFrame("members", [{ userId: "u1", role: "owner" }])), {
    t: "rows",
    topic: "members",
    rows: [{ userId: "u1", role: "owner" }],
  });
  assert.deepEqual(decodeServerFrame("person", rowsFrame("reach", [])), { t: "rows", topic: "reach", rows: [] });
  assert.deepEqual(decodeServerFrame("workspace", notServedFrame("invites")), { t: "not_served", topic: "invites" });
  assert.deepEqual(decodeServerFrame("workspace", ackFrame("a1", { removed: true })), { t: "ack", id: "a1", ok: true, result: { removed: true } });
  assert.deepEqual(decodeServerFrame("workspace", ackFrame("a2")), { t: "ack", id: "a2", ok: true, result: null }, "an ack with no result carries null");
  assert.deepEqual(decodeServerFrame("workspace", refusedFrame("a3", "insufficient_role")), {
    t: "ack",
    id: "a3",
    ok: false,
    error: "insufficient_role",
  });
  assert.deepEqual(decodeServerFrame("workspace", pongFrame()), { t: "pong" });
  // A topic from the other side is not a topic this side reads.
  assert.equal(decodeServerFrame("workspace", rowsFrame("connections", [])), null);
  assert.equal(decodeServerFrame("workspace", "{"), null);
  assert.equal(ACCESS_PROTOCOL, "context.access");
});

/* -------------------------------- the route -------------------------------- */

const TOKEN = `cat_console_${"0".repeat(24)}`;
const consoleSession = (overrides = {}) => ({
  grantId: "grant_1",
  clientId: "context_console",
  actorUserId: "u1",
  scopes: ["context:read", "context:write"],
  defaultWorkspaceId: "w1",
  workspaces: [{ workspaceId: "w1", slug: "studio", role: "member", kind: "shared", grantedNames: [] }],
  expiresAt: Date.now() + 60 * 60_000,
  ...overrides,
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
  const deps = {
    controlPlane: { resolveSession: async () => resolved },
    upgraded: (headers, webSocket) => ({ status: 101, headers, webSocket }),
  };
  const ask = ({ query = "?of=workspace", headers = {}, token = true, method = "GET", upgrade = true } = {}) => {
    const sent = { ...(upgrade ? { Upgrade: "websocket" } : {}), ...(token ? { Authorization: `Bearer ${TOKEN}` } : {}), ...headers };
    return handleAccess(new Request(`https://gateway.test/presence/access${query}`, { method, headers: sent }), env, { slug: null, pathToken: null, origin: null }, deps);
  };
  return { env, ask, forwarded };
}

test("a console grant opens the workspace object with a reader the gateway wrote, never the client's", async () => {
  const { ask, forwarded } = routeWorld(consoleSession());
  const forged = JSON.stringify({ side: "person", userId: "mallory", workspaceId: "w1", role: "owner", scope: "private", groups: ["@everyone"], deadline: 9e15 });
  const response = await ask({ headers: { [ACCESS_READER_HEADER]: forged, "x-tex-call": "x", "Sec-WebSocket-Protocol": "context.access" } });
  assert.equal(response.status, 101);
  assert.equal(response.headers.get("Sec-WebSocket-Protocol"), ACCESS_PROTOCOL, "the gateway names the access protocol");
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].name, "workspace:w1");
  const sent = forwarded[0].request.headers;
  assert.notEqual(sent.get(ACCESS_READER_HEADER), forged, "the client's forged reader never reaches the object");
  const named = JSON.parse(sent.get(ACCESS_READER_HEADER));
  assert.equal(named.side, "workspace");
  assert.equal(named.userId, "u1");
  assert.equal(named.workspaceId, "w1");
  assert.equal(named.role, "member");
  assert.equal(named.scope, "team", "a member reads at team scope");
  assert.deepEqual(named.groups, []);
  assert.equal(named.grantId, "grant_1");
  assert.ok(named.deadline <= Date.now() + ACCESS_SOCKET_MAX_MS, "a socket lives at most five minutes");
  assert.equal(sent.get("x-tex-call"), null, "no client header crosses into the object");
  assert.equal(sent.get("Sec-WebSocket-Protocol"), null);
  assert.equal(sent.get("Authorization"), null, "the token never crosses into the object");
});

test("the person side opens the person's own personal workspace as its owner", async () => {
  const resolved = consoleSession({
    defaultWorkspaceId: "w1",
    workspaces: [
      { workspaceId: "p1", slug: "me", role: "owner", kind: "personal", grantedNames: [] },
      { workspaceId: "w1", slug: "studio", role: "member", kind: "shared", grantedNames: [] },
    ],
  });
  const { ask, forwarded } = routeWorld(resolved);
  assert.equal(personalWorkspaceOf({ workspaces: resolved.workspaces }), "p1", "the personal workspace the person owns is the one named");
  const response = await ask({ query: "?of=person" });
  assert.equal(response.status, 101);
  assert.equal(forwarded[0].name, "workspace:p1");
  const named = JSON.parse(forwarded[0].request.headers.get(ACCESS_READER_HEADER));
  assert.equal(named.side, "person");
  assert.equal(named.workspaceId, "p1");
  assert.equal(named.role, "owner");
  assert.equal(named.userId, "u1");
});

test("the person side refuses with 501 when the session has no personal workspace it owns", async () => {
  const sharedOnly = routeWorld(consoleSession());
  assert.equal((await sharedOnly.ask({ query: "?of=person" })).status, 501);
  assert.equal(sharedOnly.forwarded.length, 0, "no object is reached");
  const memberOfPersonal = routeWorld(
    consoleSession({
      workspaces: [{ workspaceId: "p1", slug: "me", role: "member", kind: "personal", grantedNames: [] }],
      defaultWorkspaceId: "p1",
    }),
  );
  assert.equal((await memberOfPersonal.ask({ query: "?of=person" })).status, 501, "a personal workspace the person only reads is not theirs");
  assert.equal(memberOfPersonal.forwarded.length, 0);
});

test("the access route refuses every caller the app's own console is not", async () => {
  const other = await routeWorld(consoleSession({ clientId: "some_mcp_client" })).ask();
  assert.equal(other.status, 403, "an MCP client holding a grant is refused");
  const guest = await routeWorld(consoleSession({ workspaces: [{ workspaceId: "w1", slug: "studio", role: "member", kind: "shared", grantedNames: ["#reads-as-guest"] }] })).ask();
  assert.equal(guest.status, 403, "a guest's names starting @# are refused");
  const readless = await routeWorld(consoleSession({ scopes: ["context:write"] })).ask();
  assert.equal(readless.status, 403, "a grant without context:read is refused");
  const noMember = await routeWorld(consoleSession({ workspaces: [{ workspaceId: "w1", slug: "studio", role: "viewer", kind: "shared", grantedNames: [] }] })).ask();
  assert.equal(noMember.status, 403, "a role outside owner, editor and member is refused");
});

test("the access route answers 400 for a missing or unknown side, and reaches no object", async () => {
  const world = routeWorld(consoleSession());
  assert.equal((await world.ask({ query: "" })).status, 400, "no ?of is a bad side");
  assert.equal((await world.ask({ query: "?of=other" })).status, 400);
  assert.equal((await world.ask({ query: "?of=WORKSPACE" })).status, 400, "the side is case-sensitive");
  assert.equal(world.forwarded.length, 0);
});

test("the access route answers 426 to a plain GET, 405 to a POST, and 501 without the workspace binding", async () => {
  const world = routeWorld(consoleSession());
  assert.equal((await world.ask({ upgrade: false })).status, 426);
  assert.equal((await world.ask({ method: "POST" })).status, 405);
  const bare = await handleAccess(
    new Request("https://gateway.test/presence/access?of=workspace", { headers: { Upgrade: "websocket", Authorization: `Bearer ${TOKEN}` } }),
    {},
    { slug: null, pathToken: null, origin: null },
  );
  assert.equal(bare.status, 501);
  assert.equal(world.forwarded.length, 0);
});

test("the access route refuses a request with no token as the tree does, and never reaches an object", async () => {
  const world = routeWorld(null);
  const none = await world.ask({ token: false });
  assert.equal(none.status, 401);
  assert.equal(world.forwarded.length, 0);
});

test("the access socket reads its token from the subprotocol the app offers", async () => {
  const { ask, forwarded } = routeWorld(consoleSession());
  const offered = { token: false, headers: { "Sec-WebSocket-Protocol": `context.access, context.token.${TOKEN}` } };
  const response = await ask(offered);
  assert.equal(response.status, 101, "a console subprotocol token opens the access socket");
  assert.equal(forwarded.length, 1);
  assert.equal(response.headers.get("Sec-WebSocket-Protocol"), ACCESS_PROTOCOL, "the token offered beside it is never echoed");
});

test("the access socket is origin-checked, as every socket a browser can open", () => {
  assert.equal(ACCESS_SOCKET_PATH, "/presence/access");
  assert.equal(isTransportPath(ACCESS_SOCKET_PATH), true);
  assert.equal(isTransportPath("/presence/other"), false, "only the named socket paths are origin-checked");
});

test("the socket's path reaches the route: it is never read as a workspace's name", async () => {
  assert.deepEqual(splitWorkspacePath(ACCESS_SOCKET_PATH), { slug: null, path: ACCESS_SOCKET_PATH });
  assert.deepEqual(splitWorkspacePath(`/@studio${ACCESS_SOCKET_PATH}`), { slug: "studio", path: ACCESS_SOCKET_PATH });
  const env = { WORKSPACE_STORE: { idFromName: (name) => ({ name }), get: () => ({ fetch: async () => new Response(null, { status: 500 }) }) } };
  const answer = await route(new Request(`https://gateway.test${ACCESS_SOCKET_PATH}?of=workspace`, { headers: { Upgrade: "websocket" } }), env, { waitUntil() {} });
  assert.equal(answer.status, 401, "no token is the route's 401, never the 404 a workspace path gets");
});

/* ------------------------------ object side ------------------------------ */

const goodReader = (fields = {}) => ({
  side: "workspace",
  userId: "u1",
  workspaceId: "w1",
  role: "member",
  scope: "team",
  groups: ["design", "design"],
  grantId: "grant_1",
  deadline: 2_000_000,
  ...fields,
});

test("accessReaderOf accepts the gateway's reader and refuses one with a missing or malformed field", () => {
  const good = accessReaderOf(JSON.stringify(goodReader()));
  assert.deepEqual(good, {
    side: "workspace",
    userId: "u1",
    workspaceId: "w1",
    role: "member",
    scope: "team",
    groups: ["design"],
    grantId: "grant_1",
    deadline: 2_000_000,
  });
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ grantId: undefined }))).grantId, null, "a grant id is optional");
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ side: "person", role: "owner" }))).side, "person");

  assert.equal(accessReaderOf(null), null);
  assert.equal(accessReaderOf(undefined), null);
  assert.equal(accessReaderOf("not json"), null);
  assert.equal(accessReaderOf("{}"), null, "missing fields are refused");
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ side: "admin" }))), null, "a bad side is refused");
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ role: "admin" }))), null, "a bad role is refused");
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ scope: "public" }))), null, "a bad scope is refused");
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ deadline: undefined }))), null, "a missing deadline is refused");
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ deadline: "soon" }))), null, "a non-number deadline is refused");
  assert.equal(accessReaderOf('{"side":"workspace","userId":"u1","workspaceId":"w1","role":"member","scope":"team","groups":[],"deadline":1e400}'), null, "a non-finite deadline (1e400 parses to Infinity) is refused");
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ userId: "a/b" }))), null, "a user id with a slash is refused");
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ workspaceId: "w/1" }))), null, "a workspace id with a slash is refused");
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ userId: "" }))), null);
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ groups: "design" }))), null, "groups must be an array");
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ groups: Array.from({ length: 501 }, (_, i) => `g${i}`) }))), null, "more than 500 groups is refused");
  assert.equal(accessReaderOf(JSON.stringify(goodReader({ groups: [""] }))), null, "an empty group name is refused");
});

function accessWorld() {
  const sql = durableSql();
  const accepted = [];
  const state = {
    acceptWebSocket: (ws) => accepted.push(ws),
    getWebSockets: () => accepted.filter((ws) => ws.readyState === 1),
  };
  let now = 1_000_000;
  const access = accessSockets(state, sql, {
    now: () => now,
    pair: () => [fakeSocket(), fakeSocket()],
    schedule: () => {},
    upgraded: (client) => ({ status: 101, webSocket: client }),
  });
  const open = (fields = {}) => {
    const response = access.accept(new Request("https://x/access", { headers: { [ACCESS_READER_HEADER]: JSON.stringify(goodReader(fields)) } }));
    return { response, server: accepted[accepted.length - 1] };
  };
  const frame = (value) => JSON.stringify(value);
  return { sql, access, open, frame, advance: (ms) => (now += ms), now: () => now };
}

test("a socket with no provider for a topic is told not_served and closed", { skip }, async () => {
  const w = accessWorld();
  const { server } = w.open();
  await w.access.message(server, w.frame({ t: "sub", topics: ["members"] }));
  assert.deepEqual(server.sent, [{ t: "not_served", topic: "members" }]);
  assert.equal(server.closed.code, ACCESS_CLOSE_NOT_SERVED);
  assert.equal(ACCESS_CLOSE_NOT_SERVED, 4404);
});

test("a served topic is sent to the socket at the reader's clearance, and again only when it changed for that socket", { skip }, async () => {
  const w = accessWorld();
  let roster = [{ userId: "u1" }];
  w.access.provide({
    topics: {
      members: { served: () => true, rows: (reader) => roster.map((member) => ({ ...member, role: reader.role })) },
    },
  });
  const { server } = w.open({ role: "member" });
  await w.access.message(server, w.frame({ t: "sub", topics: ["members"] }));
  assert.equal(server.sent.length, 1);
  assert.deepEqual(server.sent[0], { t: "rows", topic: "members", rows: [{ userId: "u1", role: "member" }] });

  // Nothing changed: the same rows are not sent again.
  w.access.changed(["members"]);
  await w.access.flush();
  assert.equal(server.sent.length, 1, "unchanged rows send nothing new");

  // The provider's rows change: the new rows are sent.
  roster = [{ userId: "u1" }, { userId: "u2" }];
  w.access.changed(["members"]);
  await w.access.flush();
  assert.equal(server.sent.length, 2);
  assert.deepEqual(server.sent[1].rows, [
    { userId: "u1", role: "member" },
    { userId: "u2", role: "member" },
  ]);
});

test("a push stops for a reader the object no longer admits, as a frame of theirs would", { skip }, async () => {
  // `accept` and `message` both re-check `admitted` and close with ACCESS_CLOSE_FORBIDDEN. A pushed topic is a
  // frame of this object's access data just the same, and the push path must not be the one place that trusts
  // whoever removed the person to have called `lockOut`. Sabotage: drop the check in `flush` and this fails.
  const w = accessWorld();
  let members = new Set(["u1"]);
  let roster = [{ userId: "u1" }];
  w.access.provide({
    admit: (reader) => members.has(reader.userId),
    topics: { members: { served: () => true, rows: () => roster } },
  });
  const { server } = w.open({ userId: "u1" });
  await w.access.message(server, w.frame({ t: "sub", topics: ["members"] }));
  assert.equal(server.sent.length, 1);

  members = new Set(["u2"]);
  roster = [{ userId: "u2" }];
  w.access.changed(["members"]);
  await w.access.flush();
  assert.equal(server.sent.length, 1, "a reader this object would now refuse is sent no rows");
  assert.equal(server.closed.code, ACCESS_CLOSE_FORBIDDEN);
});

test("a write runs its handler with the stored reader and is acknowledged with its result", { skip }, async () => {
  const w = accessWorld();
  const seen = [];
  w.access.provide({
    ops: {
      remove_member: async (reader, args) => {
        seen.push({ reader, args });
        return { removed: true };
      },
    },
  });
  const { server } = w.open({ userId: "u1" });
  await w.access.message(server, w.frame({ t: "op", id: "a1", op: "remove_member", args: { userId: "u2" } }));
  assert.deepEqual(server.sent, [{ t: "ack", id: "a1", ok: true, result: { removed: true } }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reader.userId, "u1", "the handler gets the reader the gateway named");
  assert.equal(seen[0].reader.side, "workspace");
  assert.deepEqual(seen[0].args, { userId: "u2" });
});

test("a write answers not_served, its refusal code, or failed, and never reaches a handler it has no name for", { skip }, async () => {
  const w = accessWorld();
  w.access.provide({
    ops: {
      set_role: async () => {
        throw { code: "insufficient_role" };
      },
      invite: async () => {
        throw new Error("the database fell over");
      },
    },
  });
  const { server } = w.open();
  await w.access.message(server, w.frame({ t: "op", id: "b1", op: "revoke_invite", args: {} }));
  await w.access.message(server, w.frame({ t: "op", id: "b2", op: "set_role", args: { userId: "u2", role: "owner" } }));
  await w.access.message(server, w.frame({ t: "op", id: "b3", op: "invite", args: {} }));
  assert.deepEqual(server.sent, [
    { t: "ack", id: "b1", ok: false, error: "not_served" },
    { t: "ack", id: "b2", ok: false, error: "insufficient_role" },
    { t: "ack", id: "b3", ok: false, error: "failed" },
  ]);
  assert.equal(server.closed, null, "a refused write leaves the socket open");
});

test("lockOut closes one person's sockets at once and leaves the others open", { skip }, async () => {
  const w = accessWorld();
  const mine = w.open({ userId: "u1" }).server;
  const theirs = w.open({ userId: "u2" }).server;
  w.access.lockOut("u1");
  assert.equal(mine.closed.code, ACCESS_CLOSE_REAUTH);
  assert.equal(theirs.closed, null, "another person's socket stays open");
  assert.equal(theirs.readyState, 1);
});

test("a socket past its deadline is closed to be authorized again on its next message", { skip }, async () => {
  const w = accessWorld();
  const { server } = w.open({ deadline: 1_001_000 });
  w.advance(2_000);
  await w.access.message(server, w.frame({ t: "ping" }));
  assert.equal(server.closed.code, ACCESS_CLOSE_REAUTH);
  assert.deepEqual(server.sent, [], "a socket past its deadline answers nothing");
});

test("a socket's deadline is at most five minutes from when it opened", { skip }, async () => {
  const w = accessWorld();
  const { server } = w.open({ deadline: 9_000_000 });
  const held = JSON.parse(w.sql.exec("SELECT reader FROM ws_access_sockets").toArray()[0].reader);
  assert.equal(held.deadline, w.now() + ACCESS_SOCKET_MAX_MS);
  assert.equal(server.closed, null);
  w.advance(ACCESS_SOCKET_MAX_MS + 1);
  await w.access.message(server, w.frame({ t: "ping" }));
  assert.equal(server.closed.code, ACCESS_CLOSE_REAUTH);
});
