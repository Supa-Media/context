// Who may read a workspace's notes by audience (`workspaceStore/serve.js` `judgeFor`): a guest by the guest rules,
// a Tex guest chat by the guest rules rendered per the chat's names (`workspaceStore/chatRules.js`), a member by its
// own rules, and an unknown audience refused. A chat with no names sees nothing, and member rules never reach a chat.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects, TexObjectRefused } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";

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
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

/** A fake WORKSPACE_STORE namespace: one object per name, each with its own SQLite. */
function namespace() {
  const objects = new Map();
  return {
    idFromName: (name) => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const sql = durableSql();
        const store = { objects: texObjects(sql), rows: workspaceRows(sql), members: workspaceMembers(sql) };
        objects.set(id.name, { fetch: (request) => serveWorkspaceStore(store, request) });
      }
      return objects.get(id.name);
    },
  };
}

/**
 * A call answered as the object answers it, status and body. The client (`workspaceClient`) does not forward
 * `chatNames`, so a chat's reading goes through here, the way the gateway's chat reader names it.
 */
async function raw(ns, workspaceId, op, fields) {
  const stub = ns.get(ns.idFromName(`workspace:${workspaceId}`));
  return await stub.fetch(
    new Request(`https://tex-store.internal/${op}`, {
      method: "POST",
      headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) },
      body: JSON.stringify({ ...fields, workspaceId }),
    }),
  );
}

const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const MEMBER_RULES_EVERYTHING_TEAM = (accessVersion = 1) => ({
  etag: `m.${accessVersion}`,
  accessVersion,
  folders: [{ prefix: "", visibility: "team" }, { prefix: "chats", visibility: "team" }],
  notes: [],
});

const GUEST_RULES = (accessVersion = 1) => ({
  etag: `g.${accessVersion}`,
  accessVersion,
  folders: [
    { prefix: "1-projects", visibility: "team" },
    { prefix: "chats/a", visibility: "@#row1" },
    { prefix: "chats/b", visibility: "@#row2" },
  ],
  notes: [{ path: "1-projects/held.md", visibility: "private" }],
});

const NOTES = [
  { n: 1, path: "1-projects/open.md" },
  { n: 2, path: "1-projects/held.md" },
  { n: 3, path: "chats/a/x.md" },
  { n: 4, path: "chats/b/y.md" },
];

/** A workspace object with its notes' rows and bodies; rules are put by each test. */
async function seeded(ns, id = "ws_one") {
  const ws = workspaceClient({ WORKSPACE_STORE: ns }, id);
  await ws.rows.put(NOTES.map((note) => ({ id: `n${note.n}`, noteId: ID(note.n), path: note.path, kind: "file", at: 10 })));
  for (const note of NOTES) await ws.bodies.put(`notes/${ID(note.n)}.md`, `# note ${note.n}`);
  return ws;
}

/** Which of `NOTES` a chat's read sees, in order. */
async function chatSees(ns, chatNames, scope = "team") {
  const answer = await raw(ns, "ws_one", "ws.read", { ids: NOTES.map((note) => ID(note.n)), scope, audience: "chat", chatNames });
  assert.equal(answer.status, 200);
  return (await answer.json()).notes.map((note) => note.found);
}

test("a guest reads by the guest rules: the open note is shown, a note held private by name is not", { skip }, async () => {
  const ns = namespace();
  const ws = await seeded(ns);
  await ws.rules.put(GUEST_RULES(), "guest");
  const { notes } = await ws.read({ ids: [ID(1), ID(2)], scope: "team", audience: "guest" });
  assert.equal(notes[0].found, true);
  assert.equal(notes[0].text, "# note 1");
  assert.deepEqual(notes[1], { id: ID(2), found: false });
});

test("a chat reads by the guest rules rendered per its names: a token without its @ opens its folder, the other stays shut", { skip }, async () => {
  const ns = namespace();
  const ws = await seeded(ns);
  await ws.rules.put(GUEST_RULES(), "guest");
  assert.deepEqual(await chatSees(ns, ["#row1"]), [false, false, true, false]);
  assert.deepEqual(await chatSees(ns, ["@#row2"]), [false, false, false, true]);
});

test("a chat with no names, or with names that are not strings, sees nothing", { skip }, async () => {
  const ns = namespace();
  const ws = await seeded(ns);
  await ws.rules.put(GUEST_RULES(), "guest");
  assert.deepEqual(await chatSees(ns, undefined), [false, false, false, false]);
  assert.deepEqual(await chatSees(ns, []), [false, false, false, false]);
  assert.deepEqual(await chatSees(ns, [1]), [false, false, false, false]);
  assert.deepEqual(await chatSees(ns, ["#row1", 1]), [false, false, false, false]);
});

test("an unknown audience is refused, through the client and at the object", { skip }, async () => {
  const ns = namespace();
  const ws = await seeded(ns);
  await ws.rules.put(GUEST_RULES(), "guest");
  await assert.rejects(() => ws.read({ ids: [ID(1)], scope: "team", audience: "admin" }), TexObjectRefused);
  const answer = await raw(ns, "ws_one", "ws.read", { ids: [ID(1)], scope: "team", audience: "admin" });
  assert.equal(answer.status, 422);
  assert.equal((await answer.json()).error, "refused");
});

test("where members decide access, a member reading with no userId sees nothing; a guest and a chat are read by their own rules", { skip }, async () => {
  const ns = namespace();
  const ws = await seeded(ns);
  await ws.rules.put(MEMBER_RULES_EVERYTHING_TEAM(), "member");
  await ws.rules.put(GUEST_RULES(), "guest");
  await ws.members.setHome("object");

  const member = await ws.read({ ids: NOTES.map((note) => ID(note.n)), scope: "team" });
  assert.deepEqual(member.notes.map((note) => note.found), [false, false, false, false]);

  const guest = await ws.read({ ids: NOTES.map((note) => ID(note.n)), scope: "team", audience: "guest" });
  assert.deepEqual(guest.notes.map((note) => note.found), [true, false, false, false]);

  assert.deepEqual(await chatSees(ns, ["#row2"]), [false, false, false, true]);

  const lookup = await raw(ns, "ws_one", "ws.rows.lookup", { paths: ["chats/b/y.md"], scope: "team", audience: "chat", chatNames: ["#row2"] });
  assert.equal(lookup.status, 200);
  assert.equal((await lookup.json()).rows[0].found, true);
  const memberLookup = await ws.rows.lookup({ paths: ["chats/b/y.md"], scope: "team" });
  assert.deepEqual(memberLookup.rows, [{ path: "chats/b/y.md", found: false }]);
});

test("member rules never reach a chat: a chat with no matching token sees nothing in a folder the member rules open", { skip }, async () => {
  const ns = namespace();
  const ws = await seeded(ns);
  await ws.rules.put(MEMBER_RULES_EVERYTHING_TEAM(), "member");
  await ws.rules.put(GUEST_RULES(), "guest");
  assert.deepEqual(await chatSees(ns, ["#row1"]), [false, false, true, false]);
  assert.equal((await ws.read({ ids: [ID(4)], scope: "team" })).notes[0].found, true, "the member reads chats/b");
  assert.deepEqual(await chatSees(ns, ["#row3"]), [false, false, false, false], "a token that matches no rule opens nothing");
});

test("the client carries a chat's names on read, lookup and resolve", { skip }, async () => {
  const ns = namespace();
  const ws = await seeded(ns);
  await ws.rules.put(GUEST_RULES(), "guest");
  const read = await ws.read({ ids: [ID(3), ID(4)], scope: "team", audience: "chat", chatNames: ["#row1"] });
  assert.deepEqual(read.notes.map((note) => note.found), [true, false]);
  const looked = await ws.rows.lookup({ paths: ["chats/a/x.md", "chats/b/y.md"], scope: "team", audience: "chat", chatNames: ["#row1"] });
  assert.deepEqual(looked.rows.map((row) => row.found), [true, false]);
  const resolved = await ws.rows.resolve({ noteIds: [ID(3), ID(4)], scope: "team", audience: "chat", chatNames: ["#row2"] });
  assert.deepEqual(resolved.rows.map((row) => row.found), [false, true]);
});
