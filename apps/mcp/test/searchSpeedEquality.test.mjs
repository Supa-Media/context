// The search speed changes of 2026-11-18 change no answer: the same hits, the same ranking, the same order.
//
// A fixed workspace and a fixed set of queries are answered twice. "Before" is the search as it ran until then: every
// expression asked with `searchSql` and every one of them run (`answerFromProjection` over a client that runs the
// statements it is handed, which is the search database's path and was the object's). "After" is the workspace object
// as it answers now: rows read in FTS5's own rank order (`rankedSearchSql`), the any-word retry left unrun while the
// strict half finds rows and asked alone when it is needed after all, the meaning index read into memory ahead of the
// query (`warm`), and a query's fingerprint kept for the person who asked it (`queryVectors.js`).
//
// Sabotage record (temporary local edits, reverted; each one fails the named test):
//   `rankedRows` sorts ties by id descending                    -> "each query's rows ..." fails
//   `rankedRows` never answers null on a tie across the cut      -> "each query's rows ..." fails
//   `rankedSearchSql` drops its `rank MATCH` weights             -> "each query's rows ..." fails
//   the object skips the retry when the strict half found NO row -> "an ask that waits on asks before it ..." fails
//   `answerFromProjection` does not ask a skipped retry again    -> "a retry left unrun is asked alone ..." fails
//   `objectSearchAnswer` passes `lazyRetry: true` for every scope -> "a search's answer ..." fails
//   `warm` leaves the index unread                               -> "a query after a warm call ..." fails
//   the kept fingerprint's key leaves the person out             -> "a kept fingerprint is the asking person's alone" fails
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../../../packages/tex/gateway/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMarks } from "../src/workspaceStore/marks.js";
import { workspaceSearch } from "../src/workspaceStore/searchIndex.js";
import { workspaceMeaning } from "../src/workspaceStore/meaningIndex.js";
import { serveWorkspaceStore, parsedRules } from "../src/workspaceStore/serve.js";
import { workspaceClient, HOMES } from "../src/workspaceStore/api.js";
import { objectSearchAnswer } from "../src/search/objectSearch.js";
import { objectMeaningMatches, objectMeaningWarm } from "../src/search/meaning/objectMeaning.js";
import { answerFromProjection } from "../src/search/d1/serve.js";
import { canSee } from "../src/privacy/engine.js";
import {
  rankedRows,
  rankedSearchParams,
  rankedSearchSql,
  searchParams,
  searchSql,
  toRelaxedMatchExpression,
  toTypingMatchExpression,
  withWholeLines,
} from "../src/search/d1/query.js";
import { nameMatchExpression } from "../src/search/named.js";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";
import { KEEP_MS, MOST, queryEmbedderFor } from "../src/search/meaning/queryVectors.js";

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

/** The object's stores over `sql`: a second call over the same `sql` is the same workspace in an object just woken. */
function objectOver(sql) {
  const objects = texObjects(sql, { now: () => 1_000 });
  const rows = workspaceRows(sql);
  const embed = async (texts) => texts.map(fingerprint);
  const store = { objects, rows, marks: workspaceMarks(sql, { now: () => 1_000 }), search: workspaceSearch(sql, { rows, objects }), meaning: workspaceMeaning(sql, { rows, objects, embed }), sql };
  const call = async (op, fields = {}) => {
    const response = await serveWorkspaceStore(store, new Request("https://ws/call", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "w1" }) }));
    return { status: response.status, body: await response.json() };
  };
  return { store, call, sql };
}

// A fixed vocabulary, picked by a fixed sequence: the same workspace on every run.
const COMMON = ["team", "plan", "budget", "review", "meeting", "notes", "project", "status", "client", "search"];
const RARE = ["willow", "lantern", "harbor", "cedar", "quartz", "ember", "tundra", "saffron", "meadow", "copper", "falcon", "orchid", "pebble", "velvet", "zephyr", "walnut"];
let seed = 20261118;
const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
const word = () => (next() < 0.5 ? COMMON[Math.floor(next() * COMMON.length)] : RARE[Math.floor(next() * RARE.length)]);
const sentence = (words) => Array.from({ length: words }, word).join(" ");

const NOTES = [];
for (let n = 1; n <= 90; n += 1) {
  const folder = n % 3 === 0 ? "plans" : n % 3 === 1 ? "projects" : "inbox";
  // Every tenth note is several passages long, so a note is more than one chunk.
  const lines = Array.from({ length: n % 10 === 0 ? 220 : 6 + (n % 7) }, () => sentence(9));
  NOTES.push({ n, path: `${folder}/${word()}-${word()}-${n}.md`, text: `# ${sentence(3)}\n\n${lines.join("\n")}` });
}
// Notes with the same text under different names score exactly alike: ties inside the list and across its cut.
for (let n = 91; n <= 110; n += 1) NOTES.push({ n, path: `${n % 2 === 0 ? "plans" : "projects"}/copy-${n}.md`, text: "# Shared heading\n\nwillow team budget review for the harbor client\nsecond line about the lantern plan" });
// And notes the strict half finds by every word, for a query nothing else holds whole.
NOTES.push({ n: 111, path: "plans/quartz-falcon-brief.md", text: "# Quartz falcon brief\n\nthe quartz falcon launch needs a velvet orchid backdrop" });
NOTES.push({ n: 112, path: "projects/private-brief.md", text: "# Private brief\n\nthe quartz falcon launch is private until the zephyr walnut review" });

const QUERIES = [
  "willow",
  "team budget review",
  "quartz falcon launch",
  "zephyr walnut review",
  "who left the team",
  "harbor client plan status",
  "lantern pla",
  "copy",
  "shared heading",
  "saffron meadow copper pebble",
  "nothing-here-at-all xylophone",
  "the",
];

let seededObject = null;
async function seeded() {
  if (seededObject !== null) return seededObject;
  const object = objectOver(durableSql());
  await object.call("ws.home", { home: HOMES.OBJECT });
  await object.call("ws.apply", { rules: { member: { etag: "m.1", accessVersion: 1, folders: TEAM_PLANS, notes: [] } } });
  for (const { n, text } of NOTES) {
    const response = await serveWorkspaceStore(object.store, new Request("https://ws/call", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "put", key: `notes/${ID(n)}.md`, options: {} })) }, body: text }));
    assert.equal(response.status, 200);
  }
  await object.call("ws.apply", { rows: NOTES.map(({ n, path }) => ({ id: `r${n}`, noteId: ID(n), path, kind: "file", storageKey: `notes/${ID(n)}.md`, at: 10 })), at: 10 });
  for (let pass = 0; pass < 50 && (await object.call("ws.search.build")).body.waiting > 0; pass += 1);
  for (let pass = 0; pass < 50 && (await object.call("ws.meaning.build")).body.waiting > 0; pass += 1);
  seededObject = object;
  return object;
}

/** Search as it ran before: a client that runs every statement it is handed, each built by `searchSql`. */
const before = (sql) => ({ queryAll: async (statements) => statements.map(({ sql: text, params }) => sql.exec(text, ...params).toArray()) });

test("each query's rows from the object are the rows searchSql gives, in the same order", { skip }, async () => {
  const object = await seeded();
  let ranked = 0;
  let tiedAcrossTheCut = 0;
  let compared = 0;
  for (const query of QUERIES) {
    const expressions = [
      { match: toTypingMatchExpression(query), firstChunk: false },
      { match: toRelaxedMatchExpression(query), firstChunk: false },
      { match: nameMatchExpression(query), firstChunk: true },
    ].filter((entry) => typeof entry.match === "string");
    for (const { match, firstChunk } of expressions) {
      for (const table of [TEAM, PRIVATE]) {
        for (const prefix of ["", "plans/", "projects/"]) {
          for (const limit of [1, 3, 7, 25, 200]) {
            const options = { limit, prefix, firstChunk };
            const was = object.sql.exec(searchSql(table, options), ...searchParams(match, options)).toArray().map(withWholeLines);
            const answer = await object.call("ws.search", { asks: [{ table, match, prefix, limit, ...(firstChunk ? { firstChunk } : {}) }] });
            assert.equal(answer.body.served, true);
            assert.deepEqual(answer.body.answers[0], was, `${query} / ${match} / ${table} / "${prefix}" / ${limit}`);
            compared += 1;
            if (prefix === "") {
              const rows = rankedRows(object.sql.exec(rankedSearchSql(table, options), ...rankedSearchParams(match, options)).toArray(), limit);
              if (rows === null) tiedAcrossTheCut += 1;
              else if (rows.length > 1) ranked += 1;
            }
          }
        }
      }
    }
  }
  assert.ok(compared > 500, `${compared} queries compared`);
  // Both ways of answering were on the path, or this test proves less than it says.
  assert.ok(ranked > 50, `${ranked} answered in rank order`);
  assert.ok(tiedAcrossTheCut > 5, `${tiedAcrossTheCut} had a tie across the cut and were answered by searchSql`);
});

test("rows of one score keep the table's own order, and a tie across the cut is not guessed at", () => {
  const rows = [
    { id: 9, path: "c.md", score: -3 },
    { id: 4, path: "b.md", score: -2 },
    { id: 2, path: "a.md", score: -2 },
    { id: 7, path: "d.md", score: -1 },
  ];
  assert.deepEqual(rankedRows(rows, 3).map((row) => row.path), ["c.md", "a.md", "b.md"]);
  assert.equal("id" in rankedRows(rows, 3)[0], false, "the row id stays in the object");
  assert.equal(rankedRows(rows, 2), null, "the third row scores what the second does");
  assert.deepEqual(rankedRows(rows.slice(0, 2), 5).map((row) => row.path), ["c.md", "b.md"], "fewer rows than the limit are every row");
  assert.equal(rankedRows(null, 5), null);
});

test("a search's answer is the same hits in the same order as before, for every query, scope and set of rules", { skip }, async () => {
  const object = await seeded();
  let calls = 0;
  let skipped = 0;
  let waitingAsks = 0;
  const env = { WORKSPACE_STORE: { idFromName: (name) => ({ name }), get: () => ({ fetch: (request) => serveWorkspaceStore(object.store, request) }) } };
  const real = workspaceClient(env, "w1");
  const counting = {
    ...real,
    search: async (asks) => {
      calls += 1;
      if (asks.some((ask) => "unlessRows" in ask)) waitingAsks += 1;
      const answer = await real.search(asks);
      if (answer.answers?.some((rows) => rows === null)) skipped += 1;
      return answer;
    },
  };
  const store = { objectSearch: counting, defer: () => assert.fail("a served search defers nothing") };
  const live = [
    parsedRules({ folders: TEAM_PLANS, notes: [] }),
    // The strict half's only team hit is held back by name: the retry left unrun has to be asked after all.
    parsedRules({ folders: TEAM_PLANS, notes: [{ path: "plans/quartz-falcon-brief.md", visibility: "private" }] }),
    // And every copy held back, so a tied block drops out of the middle of the list.
    parsedRules({ folders: TEAM_PLANS, notes: NOTES.filter(({ path }) => path.includes("copy-")).map(({ path }) => ({ path, visibility: "private" })) }),
  ];
  let compared = 0;
  for (const query of QUERIES) {
    for (const scope of ["team", "private"]) {
      for (const { rules, overrides } of live) {
        for (const prefix of ["", "plans"]) {
          const was = await answerFromProjection(before(object.sql), {
            query,
            prefix: prefix ? `${prefix}/` : "",
            tier: scope,
            isVisible: (path) => canSee(path, scope, rules, overrides),
            missIsAnswer: true,
          });
          const waitingBefore = waitingAsks;
          const now = await objectSearchAnswer(store, scope, rules, overrides, query, prefix, { set: () => {} });
          assert.deepEqual(now, was, `${query} / ${scope} / "${prefix}"`);
          compared += 1;
          // A team caller's retry is always run beside the strict half: a second call would tell them, by its time,
          // that a note they may not read holds every word they typed.
          if (scope === "team") assert.equal(waitingAsks, waitingBefore, `${query}: a team search sends no ask that waits`);
        }
      }
    }
  }
  assert.equal(compared, QUERIES.length * 2 * live.length * 2);
  assert.equal(calls, compared, "one call to the object a search");
  assert.ok(skipped > 10, `${skipped} private-scope searches left the retry unrun`);
});

test("a retry left unrun is asked alone when no strict row is the caller's to see, and the answer is the same", { skip }, async () => {
  const object = await seeded();
  let calls = 0;
  const client = {
    search: async (asks) => {
      calls += 1;
      return (await object.call("ws.search", { asks })).body.answers;
    },
  };
  // Whatever the strict half finds is held back, so the retry decides the answer.
  const strictOnly = new Set(["plans/quartz-falcon-brief.md", "projects/private-brief.md"]);
  let reasked = 0;
  for (const query of QUERIES) {
    for (const tier of ["team", "private"]) {
      const options = { query, tier, isVisible: (path) => !strictOnly.has(path), missIsAnswer: true };
      const was = await answerFromProjection(before(object.sql), options);
      const callsBefore = calls;
      assert.deepEqual(await answerFromProjection(client, { ...options, lazyRetry: true }), was, `${query} / ${tier}`);
      if (calls - callsBefore === 2) reasked += 1;
      // Without `lazyRetry` nothing waits and nothing is asked twice.
      const callsMid = calls;
      assert.deepEqual(await answerFromProjection(client, options), was);
      assert.equal(calls - callsMid, 1);
    }
  }
  assert.ok(reasked > 0, `${reasked} searches asked the unrun retry after all`);
});

test("an ask that waits on asks before it is left unrun only while one of them found rows", { skip }, async () => {
  const object = await seeded();
  const strictHit = { table: TEAM, match: '"quartz" AND "falcon"', prefix: "", limit: 50 };
  const strictMiss = { table: TEAM, match: '"quartz" AND "xylophone"', prefix: "", limit: 50 };
  const retry = { table: TEAM, match: '"quartz" OR "falcon"', prefix: "", limit: 50 };
  const alone = (await object.call("ws.search", { asks: [retry] })).body.answers[0];
  assert.ok(alone.length > 0);
  assert.equal((await object.call("ws.search", { asks: [strictHit, { ...retry, unlessRows: [0] }] })).body.answers[1], null);
  assert.deepEqual((await object.call("ws.search", { asks: [strictMiss, { ...retry, unlessRows: [0] }] })).body.answers[1], alone);
  // An ask may wait only on asks before it: itself, a later one or anything that is not a place is refused.
  for (const unlessRows of [[1], [2], [-1], ["0"], "0"]) {
    assert.equal((await object.call("ws.search", { asks: [strictHit, { ...retry, unlessRows }] })).status, 422, JSON.stringify(unlessRows));
  }
});

test("a query after a warm call answers what a query on an object just woken answers, and says which read the index", { skip }, async () => {
  const seededOnce = await seeded();
  for (const query of QUERIES) {
    const vector = fingerprint(query);
    // Two objects just woken over the same notes: one is asked straight away, one is warmed first.
    const straight = objectOver(seededOnce.sql);
    const warmed = objectOver(seededOnce.sql);
    const was = (await straight.call("ws.meaning.query", { vector })).body;
    assert.equal(was.served, true);
    assert.equal(was.cold, true, "the first query on a woken object reads the index");
    assert.deepEqual((await warmed.call("ws.meaning.warm")).body, { served: true, loaded: true });
    assert.deepEqual((await warmed.call("ws.meaning.warm")).body, { served: true, loaded: false });
    const now = (await warmed.call("ws.meaning.query", { vector })).body;
    assert.equal(now.cold, false, "the warm call read it");
    assert.deepEqual(now.matches, was.matches, query);
    for (const tiers of [["team"], ["private"]]) {
      assert.deepEqual((await warmed.call("ws.meaning.query", { vector, tiers })).body.matches, (await straight.call("ws.meaning.query", { vector, tiers })).body.matches, `${query} / ${tiers}`);
    }
  }
});

test("a warm call before the first build is not served, and the gateway's warm never throws or waits on a failure", { skip }, async () => {
  const object = objectOver(durableSql());
  await object.call("ws.home", { home: HOMES.OBJECT });
  await object.call("ws.apply", { rules: { member: { etag: "m.1", accessVersion: 1, folders: TEAM_PLANS, notes: [] } } });
  assert.deepEqual((await object.call("ws.meaning.warm")).body, { served: false });

  await objectMeaningWarm({});
  await objectMeaningWarm({ objectMeaning: { meaningQuery: async () => ({}) } });
  await objectMeaningWarm({ objectMeaning: { meaningWarm: async () => Promise.reject(new Error("down")) } });
  await objectMeaningWarm({ objectMeaning: { meaningWarm: () => { throw new Error("down"); } } });

  // The gateway times each call by what the object said it did, under names only.
  const took = [];
  const phase = Object.assign(() => {}, { took: (name, ms) => took.push([name, typeof ms]) });
  const store = {
    phase,
    defer: () => {},
    objectMeaning: {
      meaningWarm: async () => ({ served: true, loaded: true }),
      meaningBuild: async () => ({ served: true, waiting: 0 }),
      meaningQuery: async () => ({ served: true, matches: [], cold: false }),
    },
  };
  await objectMeaningWarm(store);
  assert.deepEqual(await objectMeaningMatches(store, fingerprint("willow")), []);
  assert.deepEqual(took, [["meaning_warm_loaded", "number"], ["meaning_query_held", "number"]]);
});

const person = (userId, ai) => ({ ai, actor: { userId, workspaceId: "w1" } });
const model = () => {
  const ai = { calls: 0, failing: false };
  ai.run = async (_model, { text }) => {
    ai.calls += 1;
    if (ai.failing) throw new Error("down");
    return { data: text.map(fingerprint) };
  };
  return ai;
};

test("the same words asked again by the same person are not sent to the model again, and the fingerprint is the same", async () => {
  const ai = model();
  const first = await queryEmbedderFor(person("u1", ai))(["willow harbor"]);
  const again = await queryEmbedderFor(person("u1", ai))(["willow harbor"]);
  assert.equal(ai.calls, 1);
  assert.deepEqual(again, first);
  assert.deepEqual(first, [fingerprint("willow harbor")]);
  // Other words are asked.
  await queryEmbedderFor(person("u1", ai))(["willow harbour"]);
  assert.equal(ai.calls, 2);
});

test("a kept fingerprint is the asking person's alone", async () => {
  const ai = model();
  await queryEmbedderFor(person("u1", ai))(["willow harbor"]);
  await queryEmbedderFor(person("u2", ai))(["willow harbor"]);
  assert.equal(ai.calls, 2, "another person's same words go to the model: nobody's search is faster for somebody else's");
  // A connection with no person keeps under its grant; one with neither keeps nothing.
  const grant = { ai, actor: { grantId: "g1" } };
  await queryEmbedderFor(grant)(["willow harbor"]);
  await queryEmbedderFor(grant)(["willow harbor"]);
  assert.equal(ai.calls, 3);
  await queryEmbedderFor({ ai, actor: {} })(["willow harbor"]);
  await queryEmbedderFor({ ai, actor: {} })(["willow harbor"]);
  assert.equal(ai.calls, 5);
  // Another model binding (another host) never reads this one's.
  const other = model();
  await queryEmbedderFor(person("u1", other))(["willow harbor"]);
  assert.equal(other.calls, 1);
});

test("a fingerprint is kept for ten minutes, a failed call keeps nothing, and at most two hundred are kept", async () => {
  const ai = model();
  let clock = 1_000;
  const embed = () => queryEmbedderFor(person("u1", ai), { now: () => clock });
  await embed()(["cedar"]);
  clock += KEEP_MS - 1;
  await embed()(["cedar"]);
  assert.equal(ai.calls, 1);
  clock += 1;
  await embed()(["cedar"]);
  assert.equal(ai.calls, 2, "asked again once it is ten minutes old");

  ai.failing = true;
  await assert.rejects(embed()(["ember"]));
  ai.failing = false;
  await embed()(["ember"]);
  assert.equal(ai.calls, 4, "the failed call kept nothing");

  // Several texts at once are passages, not a query: never kept.
  await embed()(["cedar", "ember"]);
  assert.equal(ai.calls, 5);

  const calls = ai.calls;
  for (let n = 0; n < MOST + 1; n += 1) await embed()([`word ${n}`]);
  await embed()([`word ${MOST}`]);
  assert.equal(ai.calls, calls + MOST + 1, "the newest is kept");
  await embed()(["word 0"]);
  assert.equal(ai.calls, calls + MOST + 2, "the oldest was dropped to make room");
});
