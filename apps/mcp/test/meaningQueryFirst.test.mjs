// A search by meaning reads its own writes, and does not wait behind the index's build to do it
// (src/workspaceStore/meaningIndex.js `settle`, src/search/meaning/objectMeaning.js `objectMeaningMatches`).
//
// Until 2026-11-28 every search sent the object a build call just before its query. The build applied what needs no
// model (a move, a change of tier, a removal) and then asked the model for any changed text, and the query was
// answered while the model worked. So the query waited behind the build's start: its reads of the changed notes, and
// its writes to the change log, which the object holds every answer behind until they are stored. Production, the
// hour before: a query whose index was already in memory took p50 481 ms and p95 6.1 s summed over 3.4 workspaces.
//
// Now the query goes first. Where changes wait, it applies the ones that need no model itself, as the build did, and
// says how many still wait; the build is sent behind the response only then. The first five tests are what a search
// found before and still finds: they pass on the code before this change and after it. The last two are the change.
//
// Sabotage record (temporary local edits, reverted; each one fails the named test):
//   `settle` not called from `query`                       -> "a note moved just before a search ...", "... removed ...",
//                                                             "... re-tiered ..." fail
//   `settle` forgetting a row whose text changed            -> "a note whose text changed ... is still found" fails
//   the build sent before the query again                   -> "with changes waiting, the build is sent after ..." fails
//   the build sent whatever the query says                  -> "a search with nothing waiting sends no build" fails
//   `settle` run while a build is out to the model          -> "a query while a build waits on the model settles
//                                                             nothing ..." fails
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../../../packages/tex/gateway/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMarks } from "../src/workspaceStore/marks.js";
import { workspaceSearch } from "../src/workspaceStore/searchIndex.js";
import { workspaceMeaning } from "../src/workspaceStore/meaningIndex.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { HOMES } from "../src/workspaceStore/api.js";
import { meaningBuildBehind, objectMeaningMatches } from "../src/search/meaning/objectMeaning.js";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const MEMBER = (folders, accessVersion = 1) => ({ etag: `m.${accessVersion}`, accessVersion, folders, notes: [] });
const FOLDERS = [{ prefix: "plans", visibility: "team" }];

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

/** A fingerprint from words: each word lights its own dimensions, so texts sharing words are close. */
function fingerprint(text) {
  const vector = new Array(MEANING_DIMENSIONS).fill(0);
  for (const word of String(text).toLowerCase().match(/[a-z]+/g) ?? []) {
    let hash = 2166136261;
    for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    for (let k = 0; k < 8; k += 1) vector[(hash + k * 131) % MEANING_DIMENSIONS] += k % 2 === 0 ? 1 : -1;
  }
  vector[0] += 0.01;
  return vector;
}

/** A workspace object, and the gateway's client for it, which records the calls in the order the object takes them. */
function workspace() {
  const sql = durableSql();
  const objects = texObjects(sql, { now: () => 1_000 });
  const rows = workspaceRows(sql);
  // The model answers later, as Workers AI does: the object answers other calls while it waits.
  let gate = null;
  const embed = async (texts) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (gate !== null) await gate.held;
    return texts.map(fingerprint);
  };
  /** Hold the model's answers until `release()`: a build waiting on the model for as long as a test needs. */
  const hold = () => {
    let release;
    gate = { held: new Promise((resolve) => (release = resolve)) };
    return () => {
      gate = null;
      release();
    };
  };
  const store = { objects, rows, marks: workspaceMarks(sql, { now: () => 1_000 }), search: workspaceSearch(sql, { rows, objects }), meaning: workspaceMeaning(sql, { rows, objects, embed }), sql };
  const taken = [];
  const send = async (op, fields = {}, body = JSON.stringify({ ...fields, workspaceId: "w1" }), call = { op }) => {
    const response = await serveWorkspaceStore(store, new Request("https://ws/call", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify(call)) }, body }));
    assert.equal(response.status, 200, op);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  const client = {
    meaningQuery: async (vector, { tiers = null, prefix = "" } = {}) => {
      taken.push("query");
      const answer = await send("ws.meaning.query", { vector, tiers, prefix });
      taken.push("answered");
      return answer;
    },
    meaningBuild: async () => {
      taken.push("build");
      return await send("ws.meaning.build");
    },
  };
  /** One request's store at the gateway: what it defers runs behind its response. */
  const request = () => {
    const deferred = [];
    return { objectMeaning: client, defer: (promise) => deferred.push(promise), behind: () => Promise.all(deferred) };
  };
  const note = async (n, path, text, at = 10) => {
    await send("put", {}, text, { op: "put", key: `notes/${ID(n)}.md`, options: {} });
    await send("ws.apply", { rows: [{ id: `r${n}`, noteId: ID(n), path, kind: "file", storageKey: `notes/${ID(n)}.md`, at }], at });
  };
  const move = (n, path, at) => send("ws.apply", { rows: [{ id: `r${n}`, noteId: ID(n), path, kind: "file", storageKey: `notes/${ID(n)}.md`, at }], at });
  const rewrite = (n, text) => send("put", {}, text, { op: "put", key: `notes/${ID(n)}.md`, options: {} });
  /** A search by meaning, as the gateway asks it; the paths it found, best first. */
  const search = async (words, options = {}) => {
    const at = request();
    const matches = await objectMeaningMatches(at, fingerprint(words), options);
    return { paths: (matches ?? []).map((match) => match.path), behind: at.behind };
  };
  return { send, request, note, move, rewrite, search, taken, hold, meaning: store.meaning, sql };
}

/** A workspace whose index has finished its first build, holding two notes, read into memory by one search. */
async function built() {
  const ws = workspace();
  await ws.send("ws.home", { home: HOMES.OBJECT });
  await ws.send("ws.apply", { rules: { member: MEMBER(FOLDERS) } });
  await ws.note(1, "plans/garden.md", "# Garden\ntomatoes basil compost watering");
  await ws.note(2, "plans/budget.md", "# Budget\ninvoice payroll taxes quarterly");
  for (let pass = 0; pass < 10 && (await ws.send("ws.meaning.build")).waiting > 0; pass += 1);
  await (await ws.search("tomatoes")).behind();
  ws.taken.length = 0;
  return ws;
}

test("a note saved is found by meaning by the very next search, once its save's own build has run", { skip }, async () => {
  const ws = await built();
  await ws.note(3, "plans/ferry.md", "# Ferry\nharbor lantern crossing timetable");
  // The save's build, behind the save's own response (`writeProjection.js`).
  const save = ws.request();
  meaningBuildBehind(save);
  await save.behind();

  const found = await ws.search("harbor lantern crossing");
  assert.equal(found.paths[0], "plans/ferry.md");
  await found.behind();
});

test("a note moved just before a search is found at its new path, never its old one", { skip }, async () => {
  const ws = await built();
  await ws.move(1, "plans/home/garden.md", 20);
  const found = await ws.search("tomatoes compost");
  assert.equal(found.paths[0], "plans/home/garden.md");
  assert.equal(found.paths.includes("plans/garden.md"), false);
  await found.behind();
});

test("a note removed just before a search is not found", { skip }, async () => {
  const ws = await built();
  await ws.send("ws.rows.remove", { ids: ["r1"], at: 20 });
  const found = await ws.search("tomatoes compost");
  assert.equal(found.paths.includes("plans/garden.md"), false);
  assert.deepEqual(found.paths, ["plans/budget.md"]);
  await found.behind();
});

test("a note re-tiered just before a search is found at its new tier", { skip }, async () => {
  const ws = await built();
  await ws.note(3, "notes/ferry.md", "# Ferry\nharbor lantern crossing timetable");
  for (let pass = 0; pass < 10 && (await ws.send("ws.meaning.build")).waiting > 0; pass += 1);
  assert.equal((await ws.search("harbor lantern", { tiers: ["team"] })).paths.includes("notes/ferry.md"), false, "private at first");

  await ws.send("ws.apply", { rules: { member: MEMBER([...FOLDERS, { prefix: "notes", visibility: "team" }], 2) } });
  const found = await ws.search("harbor lantern", { tiers: ["team"] });
  assert.equal(found.paths[0], "notes/ferry.md");
  await found.behind();
});

test("a note whose text changed just before a search, before the model has its new text, is still found", { skip }, async () => {
  const ws = await built();
  await ws.rewrite(1, "# Garden\ntomatoes basil compost watering and pruning");
  const found = await ws.search("tomatoes compost");
  assert.equal(found.paths[0], "plans/garden.md", "found by the fingerprint it had until the new one is in");
  await found.behind();
  // And the build behind the search brought its new text in.
  assert.equal((await ws.search("pruning tomatoes")).paths[0], "plans/garden.md");
});

test("a search with nothing waiting sends no build", { skip }, async () => {
  const ws = await built();
  const found = await ws.search("tomatoes compost");
  await found.behind();
  assert.equal(found.paths[0], "plans/garden.md");
  assert.deepEqual(ws.taken, ["query", "answered"]);
});

test("with changes waiting, the build is sent after the query has its answer, behind the response", { skip }, async () => {
  const ws = await built();
  await ws.rewrite(1, "# Garden\nmarble quarry");
  const found = await ws.search("tomatoes compost");
  assert.equal(found.paths[0], "plans/garden.md");
  assert.deepEqual(ws.taken, ["query", "answered", "build"], "the build was sent once the query had its answer");
  await found.behind();
  assert.equal((await ws.search("marble quarry")).paths[0], "plans/garden.md");
});

test("a query while a build waits on the model touches nothing that build holds, and the build's text still lands", { skip }, async () => {
  const ws = await built();
  await ws.rewrite(1, "# Garden\nmarble quarry");
  // A save's build, out to the model for the new text.
  const save = ws.request();
  meaningBuildBehind(save);
  // Moved while the model works, and searched for at once: the moved row is the one that build took.
  await ws.move(1, "plans/stone/garden.md", 20);
  const found = await ws.search("tomatoes compost");
  await save.behind();
  await found.behind();
  for (let pass = 0; pass < 10 && (await ws.send("ws.meaning.build")).waiting > 0; pass += 1);
  assert.deepEqual((await ws.search("marble quarry")).paths.slice(0, 1), ["plans/stone/garden.md"], "the new text, at the new path");
});

// The query and the build never both apply a change: `settle` runs only when no build is running, and it is synchronous,
// so a build cannot start in the middle of it; a build running holds the rows it took until it has written them.
test("a query while a build waits on the model settles nothing, and both together leave the index a build alone would", { skip }, async () => {
  const ws = await built();
  await ws.rewrite(1, "# Garden\nmarble quarry");
  const release = ws.hold();
  const save = ws.request();
  meaningBuildBehind(save);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // While that build waits on the model: another note moved, and a search at once.
  await ws.move(2, "plans/money/budget.md", 20);
  const during = await ws.search("invoice payroll");
  assert.deepEqual(during.paths.slice(0, 1), ["plans/budget.md"], "the running build holds the log: the query settled nothing, as a busy build did");
  release();
  await save.behind();
  await during.behind();
  for (let pass = 0; pass < 10 && (await ws.send("ws.meaning.build")).waiting > 0; pass += 1);

  assert.equal((await ws.search("invoice payroll")).paths[0], "plans/money/budget.md");
  assert.equal((await ws.search("marble quarry")).paths[0], "plans/garden.md");
  const held = ws.sql.exec("SELECT row_id, path, tier, COUNT(*) AS n FROM ws_meaning_passages GROUP BY row_id, path, tier ORDER BY row_id").toArray();
  assert.deepEqual(held.map(({ row_id, path, tier, n }) => [row_id, path, tier, Number(n)]), [["r1", "plans/garden.md", "team", 1], ["r2", "plans/money/budget.md", "team", 1]], "one passage each, at its path: nothing applied twice");
  assert.equal(ws.meaning.state().waiting, 0);
});
