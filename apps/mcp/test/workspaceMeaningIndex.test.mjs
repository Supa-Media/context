// A workspace object's own meaning index (src/workspaceStore/meaningIndex.js) and the gateway's search by meaning
// answered out of it (src/search/meaning/objectMeaning.js): nothing is served before the first build, a build embeds
// what changed within its budget, a moved or re-tiered note keeps its fingerprints, a changed or removed note is
// found by the next build, a failed model leaves the change waiting, the scores are the cosine within rounding, and
// the object refuses asks it should.
//
// Sabotage record (temporary local edits, reverted; each one fails the named test):
//   the loop's `waiting > 0` check dropped          -> "a build loop runs while something waits, up to the cap, ..." fails
//   the loop's cap raised past MEANING_BUILD_CALLS  -> the same test fails
//   the once-per-request WeakSet check removed      -> "two triggers in one request defer one build loop ..." fails
//   a thrown `meaningBuild` let out of the loop     -> the first build-loop test fails
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMarks } from "../src/workspaceStore/marks.js";
import { workspaceSearch } from "../src/workspaceStore/searchIndex.js";
import { workspaceMeaning, quantized, signBits } from "../src/workspaceStore/meaningIndex.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { HOMES } from "../src/workspaceStore/api.js";
import { MEANING_BUILD_CALLS, meaningBuildBehind, objectMeaningMatches } from "../src/search/meaning/objectMeaning.js";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const MEMBER = (folders, notes = [], accessVersion = 1) => ({ etag: `m.${accessVersion}`, accessVersion, folders, notes });
const TEAM_PLANS = [{ prefix: "plans", visibility: "team" }];

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

function model() {
  const calls = [];
  const embed = async (texts) => {
    calls.push(texts.length);
    if (embed.failing) throw new Error("down");
    return texts.map(fingerprint);
  };
  embed.calls = calls;
  embed.failing = false;
  return embed;
}

function objectWith() {
  const sql = durableSql();
  const objects = texObjects(sql, { now: () => 1_000 });
  const rows = workspaceRows(sql);
  const embed = model();
  const store = { objects, rows, marks: workspaceMarks(sql, { now: () => 1_000 }), search: workspaceSearch(sql, { rows, objects }), meaning: workspaceMeaning(sql, { rows, objects, embed }), sql };
  const call = async (op, fields = {}) => {
    const response = await serveWorkspaceStore(store, new Request("https://ws/call", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "w1" }) }));
    return { status: response.status, body: await response.json() };
  };
  return { store, call, embed };
}

async function putBody(object, noteId, text) {
  const response = await serveWorkspaceStore(object.store, new Request("https://ws/call", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "put", key: `notes/${noteId}.md`, options: {} })) }, body: text }));
  assert.equal(response.status, 200);
}

async function note(object, n, path, text, at = 10) {
  await putBody(object, ID(n), text);
  await object.call("ws.apply", { rows: [{ id: `r${n}`, noteId: ID(n), path, kind: "file", storageKey: `notes/${ID(n)}.md`, at }], at });
}

async function seeded(folders = TEAM_PLANS) {
  const object = objectWith();
  await object.call("ws.home", { home: HOMES.OBJECT });
  await object.call("ws.apply", { rules: { member: MEMBER(folders) } });
  return object;
}

const query = (object, text, fields = {}) => object.call("ws.meaning.query", { vector: fingerprint(text), ...fields });
const paths = (answer) => answer.body.matches.map((match) => match.path);

test("nothing is served before the first build; after it the closest note is first", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/garden.md", "# Garden\ntomatoes basil compost watering");
  await note(object, 2, "plans/budget.md", "# Budget\ninvoice payroll taxes quarterly");
  assert.equal((await query(object, "tomatoes compost")).body.served, false);

  const built = await object.call("ws.meaning.build");
  assert.deepEqual(built.body, { served: true, waiting: 0 });
  const answer = await query(object, "tomatoes compost");
  assert.equal(answer.body.served, true);
  assert.equal(paths(answer)[0], "plans/garden.md");
  assert.ok(answer.body.matches[0].score > answer.body.matches[1].score);
});

test("a team-only query never answers a private note", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/team.md", "# Team\nlantern harbor");
  await note(object, 2, "private.md", "# Mine\nlantern harbor");
  await object.call("ws.meaning.build");
  assert.deepEqual(paths(await query(object, "lantern", { tiers: ["team"] })), ["plans/team.md"]);
  assert.equal((await query(object, "lantern")).body.matches.length, 2);
});

// Sabotage: drop the same-text branch in `catchUp` and the embed count rises.
test("a moved note and a change of rules keep its fingerprints; only a changed text is embedded again", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# A\ncedar forest");
  await object.call("ws.meaning.build");
  const embedded = object.embed.calls.length;
  // Asked once first, so the passages held in memory are what the move has to update.
  assert.deepEqual(paths(await query(object, "cedar")), ["plans/a.md"]);

  await object.call("ws.apply", { rows: [{ id: "r1", noteId: ID(1), path: "plans/moved/a.md", kind: "file", storageKey: `notes/${ID(1)}.md`, at: 20 }], at: 20 });
  await object.call("ws.meaning.build");
  assert.deepEqual(paths(await query(object, "cedar")), ["plans/moved/a.md"]);

  await object.call("ws.apply", { rules: { member: MEMBER([], [], 2) } });
  await object.call("ws.meaning.build");
  assert.deepEqual(paths(await query(object, "cedar", { tiers: ["team"] })), [], "now private");
  assert.equal(object.embed.calls.length, embedded, "no model call for a move or a re-tier");

  await putBody(object, ID(1), "# A\nmarble quarry");
  await object.call("ws.meaning.build");
  assert.equal(object.embed.calls.length, embedded + 1);
  assert.equal(paths(await query(object, "marble quarry"))[0], "plans/moved/a.md");
});

test("a removed note is gone after the next build", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# A\nwillow");
  await note(object, 2, "plans/b.md", "# B\nwillow");
  await object.call("ws.meaning.build");
  await object.call("ws.apply", { rows: [], removed: ["r1"], at: 30 });
  await object.call("ws.meaning.build");
  assert.deepEqual(paths(await query(object, "willow")), ["plans/b.md"]);
});

test("a build stops at its passage budget and the next one carries on", { skip }, async () => {
  const object = await seeded();
  for (let n = 1; n <= 4; n += 1) await note(object, n, `plans/n${n}.md`, `# N${n}\nfern`);
  const first = await object.store.meaning.catchUp({ passages: 2 });
  assert.equal(first.waiting, 2);
  assert.equal((await query(object, "fern")).body.served, false, "not served until the first build has finished");
  const second = await object.store.meaning.catchUp({ passages: 2 });
  assert.equal(second.waiting, 0);
  assert.equal((await query(object, "fern")).body.matches.length, 4);
});

// Sabotage: drop `log.again` in `catchUp` and the note is never embedded.
test("a failed model leaves the change waiting for the next build", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# A\nquartz");
  object.embed.failing = true;
  const failed = await object.call("ws.meaning.build");
  assert.equal(failed.body.failed, true);
  object.embed.failing = false;
  assert.deepEqual((await object.call("ws.meaning.build")).body, { served: true, waiting: 0 });
  assert.deepEqual(paths(await query(object, "quartz")), ["plans/a.md"]);
});

test("a second build while one waits on the model says busy and embeds nothing", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# A\nopal");
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const inner = object.store.meaning;
  const slow = workspaceMeaning(object.store.sql, { rows: object.store.rows, objects: object.store.objects, embed: async (texts) => (await gate, texts.map(fingerprint)) });
  object.store.meaning = slow;
  const first = object.call("ws.meaning.build");
  const second = await object.call("ws.meaning.build");
  assert.equal(second.body.busy, true);
  release();
  assert.equal((await first).body.waiting, 0);
  object.store.meaning = inner;
});

test("a score is the cosine within the bytes' rounding", { skip }, async () => {
  const a = fingerprint("alpha beta gamma delta");
  const b = fingerprint("alpha beta epsilon zeta");
  const norm = (v) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  const exact = a.reduce((sum, x, i) => sum + x * b[i], 0) / (norm(a) * norm(b));
  const unitB = b.map((x) => x / norm(b));
  const { q, scale } = quantized(Float32Array.from(unitB));
  const unitA = a.map((x) => x / norm(a));
  const approx = unitA.reduce((sum, x, i) => sum + x * q[i] * scale, 0);
  assert.ok(Math.abs(exact - approx) < 0.01, `${exact} vs ${approx}`);
  assert.equal(signBits(Float32Array.from(unitA)).length, MEANING_DIMENSIONS / 32);
});

test("a query that is not a whole fingerprint, names another tier or asks for too many is refused", { skip }, async () => {
  const object = await seeded();
  for (const fields of [{ vector: [1, 2, 3] }, { vector: fingerprint("x"), tiers: ["public"] }, { vector: fingerprint("x"), topK: 51 }, { vector: new Array(MEANING_DIMENSIONS).fill(0) }]) {
    const answer = await object.call("ws.meaning.query", fields);
    assert.equal(answer.status, 422, JSON.stringify(Object.keys(fields)));
  }
});

test("the object answers nothing while it is not the home of the notes", { skip }, async () => {
  const object = objectWith();
  await object.call("ws.apply", { rules: { member: MEMBER(TEAM_PLANS) } });
  assert.deepEqual((await query(object, "x")).body, { served: false });
  assert.deepEqual((await object.call("ws.meaning.build")).body, { served: false });
});

test("the gateway uses the object's matches when served, and otherwise answers null; a build goes behind either way", async () => {
  const deferred = [];
  const served = { meaningQuery: async () => ({ served: true, matches: [{ id: "1", score: 0.7, path: "a.md", chunk: 0, tier: "team" }] }), meaningBuild: async () => ({ served: true, waiting: 0 }) };
  const matches = await objectMeaningMatches({ objectMeaning: served, defer: (work) => deferred.push(work) }, [0.1], { tiers: ["team"] });
  assert.deepEqual(matches.map((match) => match.path), ["a.md"]);
  assert.equal(deferred.length, 1);

  let builds = 0;
  const waiting = { meaningQuery: async () => ({ served: false, waiting: 9 }), meaningBuild: async () => ((builds += 1), { served: true, waiting: builds < 3 ? 5 : 0 }) };
  assert.equal(await objectMeaningMatches({ objectMeaning: waiting, defer: (work) => deferred.push(work) }, [0.1]), null);
  await deferred[1];
  assert.equal(builds, 3, "builds go on while something waits");
  assert.equal(await objectMeaningMatches({ objectMeaning: { meaningQuery: async () => { throw new Error("down"); } } }, [0.1]), null);
  assert.equal(await objectMeaningMatches({}, [0.1]), null);
});

/** Run `meaningBuildBehind` on a store whose `meaningBuild` answers `answer(call)`, and count the calls made. */
async function buildsBehind(answer) {
  const deferred = [];
  let calls = 0;
  const store = {
    objectMeaning: {
      meaningBuild: async () => {
        calls += 1;
        return answer(calls);
      },
    },
    defer: (work) => deferred.push(work),
  };
  meaningBuildBehind(store);
  await Promise.all(deferred);
  return { calls, deferred: deferred.length };
}

test("a build loop runs while something waits, up to the cap, and stops on busy, unserved or a throw", async () => {
  assert.deepEqual(await buildsBehind(() => ({ served: true, waiting: 5 })), { calls: MEANING_BUILD_CALLS, deferred: 1 });
  assert.deepEqual(await buildsBehind((call) => ({ served: true, waiting: call < 3 ? 5 : 0 })), { calls: 3, deferred: 1 });
  assert.deepEqual(await buildsBehind(() => ({ served: true, waiting: 5, busy: true })), { calls: 1, deferred: 1 });
  assert.deepEqual(await buildsBehind(() => ({ served: false, waiting: 5 })), { calls: 1, deferred: 1 });
  assert.deepEqual(await buildsBehind(() => ({ served: true, waiting: 0 })), { calls: 1, deferred: 1 });
  assert.deepEqual(await buildsBehind(() => { throw new Error("model down"); }), { calls: 1, deferred: 1 });
});

test("no build loop without an object that can build, or without a way to defer it", async () => {
  const deferred = [];
  assert.equal(await meaningBuildBehind({ objectMeaning: null, defer: (work) => deferred.push(work) }), undefined);
  assert.equal(await meaningBuildBehind({ objectMeaning: { meaningQuery: async () => ({}) }, defer: (work) => deferred.push(work) }), undefined);
  assert.equal(await meaningBuildBehind({}), undefined);
  assert.equal(deferred.length, 0);

  let built = 0;
  const noDefer = { objectMeaning: { meaningBuild: async () => ((built += 1), { served: true, waiting: 1 }) } };
  await meaningBuildBehind(noDefer);
  assert.equal(built, 0, "without store.defer nothing runs in front of the response");

  const refusing = { objectMeaning: { meaningBuild: async () => ({ served: true, waiting: 1 }) }, defer: () => { throw new Error("no waitUntil"); } };
  await meaningBuildBehind(refusing);
});

test("two triggers in one request defer one build loop between them, a search's included", async () => {
  const deferred = [];
  let calls = 0;
  const store = {
    objectMeaning: {
      meaningQuery: async () => ({ served: false, waiting: 1 }),
      meaningBuild: async () => ((calls += 1), { served: true, waiting: 0 }),
    },
    defer: (work) => deferred.push(work),
  };
  await meaningBuildBehind(store);
  await meaningBuildBehind(store);
  await objectMeaningMatches(store, [0.1]);
  assert.equal(deferred.length, 1);
  await Promise.all(deferred);
  assert.equal(calls, 1);

  const other = { objectMeaning: store.objectMeaning, defer: (work) => deferred.push(work) };
  await objectMeaningMatches(other, [0.1]);
  assert.equal(deferred.length, 2, "a new request store defers its own loop");
  await Promise.all(deferred);
});

// Sabotage: embed each row on its own (`await embedAll(texts)` per row) and the call count is the note count.
test("a build asks the model for many notes' passages together, not one note at a time", { skip }, async () => {
  const object = await seeded();
  for (let n = 1; n <= 40; n += 1) await note(object, n, `plans/n${n}.md`, `# N${n}\nwillow`);
  assert.deepEqual((await object.call("ws.meaning.build")).body, { served: true, waiting: 0 });
  assert.deepEqual(object.embed.calls, [32, 8], "40 one-passage notes are two model calls of at most 32");
  assert.equal((await query(object, "willow")).body.matches.length, 40);
});

// Sabotage: drop the `log.again` loop and the notes after the first are never embedded.
test("a failed model puts every note of the round back", { skip }, async () => {
  const object = await seeded();
  for (let n = 1; n <= 3; n += 1) await note(object, n, `plans/n${n}.md`, `# N${n}\nbirch`);
  object.embed.failing = true;
  assert.equal((await object.call("ws.meaning.build")).body.failed, true);
  object.embed.failing = false;
  assert.deepEqual((await object.call("ws.meaning.build")).body, { served: true, waiting: 0 });
  assert.equal((await query(object, "birch")).body.matches.length, 3);
});

// Sabotage: skip the round's still-current check and the note keeps the old text's fingerprint under its new etag.
test("a note changed while the model answers is not written; its change waits for the next build", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# A\ncedar");
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const inner = object.store.meaning;
  object.store.meaning = workspaceMeaning(object.store.sql, { rows: object.store.rows, objects: object.store.objects, embed: async (texts) => (await gate, texts.map(fingerprint)) });
  const building = object.call("ws.meaning.build");
  await putBody(object, ID(1), "# A\nmaple");
  release();
  assert.equal((await building).body.waiting, 1, "the change made during the build is still waiting");
  assert.equal(object.store.sql.exec("SELECT COUNT(*) AS n FROM ws_meaning_passages").toArray()[0].n, 0, "the old text's fingerprint is not kept");
  object.store.meaning = inner;
});

// Sabotage: drop the `store.objectMeaning` test in `snippetsFor` and the search database is asked first.
test("a note found only by meaning in an object workspace gets its snippet from the object, not the search database", async () => {
  const { withMeaning } = await import("../src/search/meaning/serve.js");
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    throw new Error("no network in tests");
  };
  try {
    const store = {
      objectMeaning: {},
      searchIndex: { state: "ready", accountId: "acct", databaseId: "db", apiToken: "token" },
      get: async (path) => (path === "plans/a.md" ? { text: async () => "# A\nthe walnut grove by the river" } : null),
    };
    const merged = await withMeaning(store, { hits: [], matchCount: 0 }, [{ path: "plans/a.md", score: 0.8, chunk: 0 }]);
    assert.equal(fetched, 0, "the search database was not asked");
    assert.equal(merged.hits.length, 1);
    assert.match(merged.hits[0].snippets[0], /walnut grove/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Sabotage: return `{}` from `snippets` and the gateway shows no meaning-only note.
test("the object answers every snippet a search asks for in one call, and nothing for a path it does not hold", { skip }, async () => {
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# Oak\nthe acorn harvest in the north field");
  const answer = await object.call("ws.meaning.snippets", { asks: [{ path: "plans/a.md", chunk: 0 }, { path: "plans/gone.md", chunk: 0 }], chars: 200 });
  assert.equal(answer.body.served, true);
  assert.match(answer.body.snippets["plans/a.md"].snippets[0], /acorn harvest/);
  assert.equal(answer.body.snippets["plans/gone.md"], null);
  for (const fields of [{ asks: [] }, { asks: [{ path: 1, chunk: 0 }] }, { asks: Array.from({ length: 51 }, (_, n) => ({ path: `p${n}.md`, chunk: 0 })) }]) {
    assert.equal((await object.call("ws.meaning.snippets", fields)).status, 422);
  }

  const { withMeaning } = await import("../src/search/meaning/serve.js");
  let reads = 0;
  const store = {
    objectMeaning: { meaningSnippets: async (asks, chars) => (await object.call("ws.meaning.snippets", { asks, chars })).body },
    get: async () => ((reads += 1), null),
  };
  const merged = await withMeaning(store, { hits: [], matchCount: 0 }, [{ path: "plans/a.md", score: 0.8, chunk: 0 }]);
  assert.equal(reads, 0, "no note was read on its own");
  assert.match(merged.hits[0].snippets[0], /acorn harvest/);
});

// Sabotage: put a refused round back (as any failure) and the build never finishes, so the index is never served.
test("a note the model refuses every way is skipped, and the rest of the workspace is built and served", { skip }, async () => {
  const { MeaningError } = await import("../src/search/meaning/errors.js");
  const object = await seeded();
  await note(object, 1, "plans/good.md", "# Good\nwillow");
  await note(object, 2, "plans/bad.md", "# Bad\npoison willow");
  await note(object, 3, "plans/also.md", "# Also\nwillow");
  const plain = object.store.meaning;
  let asked = 0;
  object.store.meaning = workspaceMeaning(object.store.sql, {
    rows: object.store.rows,
    objects: object.store.objects,
    embed: async (texts) => {
      asked += texts.length;
      if (texts.some((text) => text.includes("poison"))) {
        throw new MeaningError("REFUSED", { cause: "http_400", operation: "embed", providerCodes: [3030], probeStatus: "accepted" });
      }
      return texts.map(fingerprint);
    },
  });
  assert.ok(plain);
  assert.deepEqual((await object.call("ws.meaning.build")).body, { served: true, waiting: 0 });
  assert.deepEqual(paths(await query(object, "willow")).sort(), ["plans/also.md", "plans/good.md"]);
  // Not asked again while its text is the same.
  const before = asked;
  assert.deepEqual((await object.call("ws.meaning.build")).body, { served: true, waiting: 0 });
  assert.equal(asked, before);
});

test("a model that refuses everything is a failure, not a skip", { skip }, async () => {
  const { MeaningError } = await import("../src/search/meaning/errors.js");
  const object = await seeded();
  await note(object, 1, "plans/a.md", "# A\nwillow");
  object.store.meaning = workspaceMeaning(object.store.sql, {
    rows: object.store.rows,
    objects: object.store.objects,
    embed: async () => {
      throw new MeaningError("REFUSED", { cause: "http_400", operation: "embed", providerCodes: [3030], probeStatus: "refused" });
    },
  });
  assert.equal((await object.call("ws.meaning.build")).body.failed, true);
});
