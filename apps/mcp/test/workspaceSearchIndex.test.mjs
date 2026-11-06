// A workspace object's own word index (src/workspaceStore/searchIndex.js) and the gateway's search answered out of it
// (src/search/objectSearch.js): each note is indexed in the tier the member rules give it, a changed body, a moved note
// and a removed one are found by the next search, a search over the budget says `waiting` and a build catches up, the
// object refuses asks it should, and the gateway's live canSee still decides what is shown.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMarks } from "../src/workspaceStore/marks.js";
import { workspaceSearch, QUERY_ROWS, QUERY_BYTES, BUILD_BYTES } from "../src/workspaceStore/searchIndex.js";
import { serveWorkspaceStore, parsedRules } from "../src/workspaceStore/serve.js";
import { workspaceClient, HOMES } from "../src/workspaceStore/api.js";
import { objectSearchAnswer } from "../src/search/objectSearch.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

const TEAM = "notes_team_fts";
const PRIVATE = "notes_private_fts";
const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const MEMBER = (folders, notes = [], accessVersion = 1) => ({ etag: `m.${accessVersion}`, accessVersion, folders, notes });
const TEAM_PLANS = [{ prefix: "plans", visibility: "team" }];
const ask = (table, word, limit = 50) => ({ table, match: `"${word}"`, prefix: "", limit });
const paths = (rows) => rows.map((row) => row.path);

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

function objectWith(clock = { now: 1_000 }) {
  const sql = durableSql();
  const objects = texObjects(sql, { now: () => clock.now });
  const rows = workspaceRows(sql);
  const store = { objects, rows, marks: workspaceMarks(sql, { now: () => clock.now }), search: workspaceSearch(sql, { rows, objects }), sql };
  const call = async (op, fields = {}) => {
    const response = await serveWorkspaceStore(store, new Request("https://ws/call", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "w1" }) }));
    return { status: response.status, body: await response.json() };
  };
  return { store, call, clock };
}

/** A note's body, put the way the gateway's bucket client puts it (`texStore/wire.js` `put`). */
async function putBody(object, noteId, text) {
  const response = await serveWorkspaceStore(object.store, new Request("https://ws/call", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "put", key: `notes/${noteId}.md`, options: {} })) }, body: text }));
  assert.equal(response.status, 200);
}

async function row(object, n, path, at = 10) {
  await object.call("ws.apply", { rows: [{ id: `r${n}`, noteId: ID(n), path, kind: "file", storageKey: `notes/${ID(n)}.md`, at }], at });
}

async function note(object, n, path, text, at = 10) {
  await putBody(object, ID(n), text);
  await row(object, n, path, at);
}

/** A workspace whose home is its object and whose member rules are `folders`. */
async function seeded(folders = TEAM_PLANS) {
  const object = objectWith();
  await object.call("ws.home", { home: HOMES.OBJECT });
  await object.call("ws.apply", { rules: { member: MEMBER(folders) } });
  return object;
}

test("a team note and a private note are indexed in their own tables, and each table answers only its tier", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/team.md", "# Team\nlantern plan");
  await note(object, 2, "root.md", "# Private\nlantern private");
  const answer = await object.call("ws.search", { asks: [ask(TEAM, "lantern"), ask(PRIVATE, "lantern")] });
  assert.equal(answer.body.served, true);
  assert.deepEqual(paths(answer.body.answers[0]), ["plans/team.md"]);
  assert.deepEqual(paths(answer.body.answers[1]), ["root.md"]);
});

test("a hit's snippet is the whole line it is on, never a twelve-word window that cuts off its start", { skip }, async () => {
  // Core benchmark q14 (2026-11-05): "…40 m from Harbor Linen Mill, by October 20" hid "twill" in all six runs.
  const object = await seeded();
  const line = "- [ ] Place the fabric order for the twill trousers: 40 m from Harbor Linen Mill, by October 20";
  await note(object, 1, "plans/todo.md", `# To do\n\n- [ ] Order swatches from the knit mill\n${line}\n- [ ] Send the line sheet to the shop`);
  const [hit] = (await object.call("ws.search", { asks: [ask(TEAM, "20")] })).body.answers[0];
  assert.equal(hit.snippet.split("\n")[0], line, "the line is whole, from its start");
  assert.equal(hit.snippet.includes("…"), false);
  assert.equal("chunk" in hit, false, "the chunk the line was cut from stays in the object");
});

test("a changed body, a moved note and a removed note are found by the next search", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# A\nalpha beacon");
  const search = async (word) => paths((await object.call("ws.search", { asks: [ask(TEAM, word)] })).body.answers[0]);
  assert.deepEqual(await search("alpha"), ["plans/a.md"]);

  object.clock.now += 10;
  await putBody(object, ID(1), "# A\nbravo beacon");
  assert.deepEqual(await search("alpha"), [], "the old word is gone");
  assert.deepEqual(await search("bravo"), ["plans/a.md"], "the new word is found");

  object.clock.now += 10;
  await object.call("ws.apply", { rows: [{ id: "r1", noteId: ID(1), path: "plans/moved/a.md", kind: "file", storageKey: `notes/${ID(1)}.md`, at: 30 }], at: 30 });
  assert.deepEqual(await search("bravo"), ["plans/moved/a.md"], "the new path is carried");

  object.clock.now += 10;
  await object.call("ws.apply", { rows: [], removed: ["r1"], at: 40 });
  assert.deepEqual(await search("bravo"), [], "a removed note is no longer found");
});

test("a change to the member rules re-tiers a note: found in the private table, not the team one", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# A\ncedar token");
  const answer = async (table) => paths((await object.call("ws.search", { asks: [ask(table, "cedar")] })).body.answers[0]);
  assert.deepEqual(await answer(TEAM), ["plans/a.md"]);

  await object.call("ws.apply", { rules: { member: MEMBER([], [], 2) } });
  assert.deepEqual(await answer(TEAM), [], "no longer a team note");
  assert.deepEqual(await answer(PRIVATE), ["plans/a.md"], "now a private note");
});

test("a search over the budget says waiting, and a build catches up so the next search is served", { skip }, async () => {
  const object = await seeded();
  const many = 2 * QUERY_ROWS + 5;
  for (let n = 1; n <= many; n += 1) await note(object, n, `plans/n${n}.md`, `# N${n}\nmarble`);
  const first = await object.call("ws.search", { asks: [ask(TEAM, "marble")] });
  assert.equal(first.body.served, false);
  assert.ok(first.body.waiting > 2 * QUERY_ROWS, "every changed note is still waiting");

  const built = await object.call("ws.search.build");
  assert.deepEqual(built.body, { served: true, waiting: 0 });
  const second = await object.call("ws.search", { asks: [ask(TEAM, "marble", 500)] });
  assert.equal(second.body.served, true);
  assert.equal(second.body.answers[0].length, many);
});

// Sabotage: drop the byte check from `catchUp` and the first build indexes all three, failing `waiting`.
test("a build stops at its text budget, a note longer than it still indexed whole and alone", { skip }, async () => {
  const object = await seeded();
  const long = "# Long\n" + "sequoia ".repeat(Math.ceil(BUILD_BYTES / 8) + 10);
  await note(object, 1, "plans/long.md", long);
  await note(object, 2, "plans/b.md", "# B\nsequoia");
  await note(object, 3, "plans/c.md", "# C\nsequoia");
  const first = await object.call("ws.search.build");
  assert.equal(first.body.waiting, 2, "the long note spent the call");
  const second = await object.call("ws.search.build");
  assert.equal(second.body.waiting, 0);
  const answer = await object.call("ws.search", { asks: [ask(TEAM, "sequoia", 500)] });
  assert.equal(new Set(paths(answer.body.answers[0])).size, 3);
});

test("a search with a long note waiting is not served, and does not index it inline", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# A\nfern");
  assert.equal((await object.call("ws.search", { asks: [ask(TEAM, "fern")] })).body.served, true);
  await putBody(object, ID(1), "# A\n" + "fern ".repeat(QUERY_BYTES));
  await note(object, 2, "plans/b.md", "# B\nfern");
  const answer = await object.call("ws.search", { asks: [ask(TEAM, "fern")] });
  assert.equal(answer.body.served, false, "the second note waits behind the long one");
});

test("the search is not served while the object is not the home of the notes", { skip }, async () => {
  const object = objectWith();
  await object.call("ws.apply", { rules: { member: MEMBER(TEAM_PLANS) } });
  await note(object, 1, "plans/a.md", "# A\nquartz");
  assert.deepEqual((await object.call("ws.search", { asks: [ask(TEAM, "quartz")] })).body, { served: false });
  assert.deepEqual((await object.call("ws.search.build")).body, { served: false });
});

test("asks naming another table, an empty match, a row cap outside 1 to 500, or more than six asks are refused", { skip }, async () => {
  const object = await seeded();
  const refused = [
    [ask("ws_rows", "x")],
    [{ ...ask(TEAM, "x"), match: "" }],
    [ask(TEAM, "x", 0)],
    [ask(TEAM, "x", 501)],
    Array.from({ length: 7 }, () => ask(TEAM, "x")),
    [],
  ];
  for (const asks of refused) {
    const answer = await object.call("ws.search", { asks });
    assert.equal(answer.status, 422, JSON.stringify(asks));
    assert.equal(answer.body.error, "refused");
  }
});

test("the gateway's search answers out of the object and keeps only what its live canSee shows", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# A\nwillow");
  await note(object, 2, "plans/b.md", "# B\nwillow");
  // The object indexed plans/a.md as team; the gateway's live rules now hold it private, and canSee decides.
  const env = { WORKSPACE_STORE: { idFromName: (name) => ({ name }), get: () => ({ fetch: (request) => serveWorkspaceStore(object.store, request) }) } };
  const store = { objectSearch: workspaceClient(env, "w1"), defer: () => assert.fail("a served search defers nothing") };
  const live = parsedRules({ folders: TEAM_PLANS, notes: [{ path: "plans/a.md", visibility: "private" }] });
  const trace = new Map();
  const answer = await objectSearchAnswer(store, "team", live.rules, live.overrides, "willow", "", { set: (key, value) => trace.set(key, value) });
  assert.deepEqual(answer.hits.map((hit) => hit.key), ["plans/b.md"]);
  assert.equal(answer.matchCount, 1, "the count is taken after canSee");
  assert.equal(trace.get("objectSearch"), "served");
});

test("while the object is catching up the gateway answers null and defers one catch-up pass", { skip }, async () => {
  let built = 0;
  const deferred = [];
  const store = {
    objectSearch: {
      search: async () => ({ served: false, waiting: 3 }),
      searchBuild: async () => {
        built += 1;
        return { served: true, waiting: 0 };
      },
    },
    defer: (promise) => deferred.push(promise),
  };
  const live = parsedRules(MEMBER(TEAM_PLANS));
  const trace = new Map();
  const answer = await objectSearchAnswer(store, "team", live.rules, live.overrides, "willow", "", { set: (key, value) => trace.set(key, value) });
  assert.equal(answer, null);
  assert.equal(deferred.length, 1);
  assert.ok(deferred[0] instanceof Promise);
  await deferred[0];
  assert.equal(built, 1);
  assert.equal(trace.get("objectSearch"), "catching_up");
});

// Sabotage: drop the text triggers (`textTriggers`) and this fails: the row did not change, only its text.
test("a body written again in the same millisecond is indexed again", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# A\n\nmarigold");
  assert.deepEqual(paths((await object.call("ws.search", { asks: [ask(TEAM, "marigold")] })).body.answers[0]), ["plans/a.md"]);
  await putBody(object, ID(1), "# A\n\nzinnia");
  const after = (await object.call("ws.search", { asks: [ask(TEAM, "zinnia"), ask(TEAM, "marigold")] })).body.answers;
  assert.deepEqual(paths(after[0]), ["plans/a.md"]);
  assert.deepEqual(paths(after[1]), []);
});

// A person's own Tex notes live in this object's Tex tables (`store/texRouting.js`); a group chat's home does not.
// Sabotage: drop the Tex branch of `textAt` and the first assertion fails.
test("a person's Tex note is found from its Tex tables; a group chat's home note is not indexed here", { skip }, async () => {
  const { TEX_TABLES } = await import("../src/texStore/objects.js");
  const object = await seeded([{ prefix: "tex", visibility: "team" }]);
  const tex = texObjects(object.store.sql, { tables: TEX_TABLES });
  await tex.put(`notes/${ID(7)}.md`, new TextEncoder().encode("# About\n\nhollyhock"), {});
  await object.call("ws.apply", { rows: [{ id: "r7", noteId: ID(7), path: "tex/about.md", kind: "file", storageKey: `tex/person:w1/notes/${ID(7)}.md`, at: 10 }], at: 10 });
  await object.call("ws.apply", { rows: [{ id: "r8", noteId: ID(8), path: "tex/groups/g/memory.md", kind: "file", storageKey: `tex/chat:abc/notes/${ID(8)}.md`, at: 11 }], at: 11 });
  const answer = (await object.call("ws.search", { asks: [ask(TEAM, "hollyhock")] })).body;
  assert.equal(answer.served, true);
  assert.deepEqual(paths(answer.answers[0]), ["tex/about.md"]);
});
