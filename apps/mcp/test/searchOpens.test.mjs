// Opens as search evidence (Dev2, 2026-11-22): every open of a note is one row in its workspace object's log
// (src/workspaceStore/opens.js) with who, whether a person or an AI client, the surface and the client; search reads the
// searcher's own opens, everyone else's and AI reads apart from that log and raises a note that holds every word of
// the query by them ("Opened before", src/search/stages.js byOpens, src/search/fuse.js).
//
// Sabotage, each confirmed to fail a case here: count AI reads as people's (the AI-read note outranks the person's),
// key the log by path (a renamed note loses its history), give `used` to a loose or meaning-only row (the brushed index
// page rises), and leave `opens` on the fused answer (counts leak into the hits a client sees).
import { test } from "node:test";
import assert from "node:assert/strict";

import { workspaceOpens, OpensRefused } from "../src/workspaceStore/opens.js";
import { countAiRead, countPersonOpen, openWeight, opensOf } from "../src/search/opens.js";
import { byOpens, mergeLists } from "../src/search/stages.js";
import { fuseEverywhere } from "../src/search/fuse.js";
import { DEFAULT_RANKING, FUSE_RANKING } from "../src/search/ranking.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function durableSql() {
  const db = new DatabaseSync(":memory:");
  const sql = {
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
  sql.exec("CREATE TABLE ws_rows (id TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, gone INTEGER NOT NULL DEFAULT 0)");
  return sql;
}

test("each open is logged, and counts come back as the asker's own, everyone's and AI reads apart", { skip }, () => {
  const sql = durableSql();
  sql.exec("INSERT INTO ws_rows (id, path, kind) VALUES ('r1', 'trips/packing.md', 'file'), ('r2', 'index.md', 'file')");
  const opens = workspaceOpens(sql, { now: () => 1 });
  assert.deepEqual(opens.record({ path: "trips/packing.md", who: "u_priya", by: "person", count: 3 }), { recorded: true });
  opens.record({ path: "trips/packing.md", who: "u_john", by: "person" });
  // An AI read keeps the person it was for, and still counts only as an AI read.
  opens.record({ path: "trips/packing.md", who: "u_priya", by: "ai", surface: "text", client: "context_texts", clientName: "Tex" });
  opens.record({ path: "index.md", by: "ai", client: "claude_ai" });
  assert.deepEqual(opens.of({ paths: ["trips/packing.md", "index.md", "nowhere.md"], who: "u_priya" }).opens, {
    "trips/packing.md": { mine: 3, people: 4, ai: 1 },
    "index.md": { mine: 0, people: 0, ai: 1 },
  });
  // Every row keeps what was known of the open, so a new signal is a new query over the same log.
  const logged = sql.exec("SELECT who, by, surface, client, client_name FROM ws_open_log WHERE by = 'ai' ORDER BY seq").toArray();
  assert.deepEqual(logged.map((r) => [r.who, r.by, r.surface, r.client, r.client_name]), [
    ["u_priya", "ai", "text", "context_texts", "Tex"],
    [null, "ai", "mcp", "claude_ai", null],
  ]);
});

test("a renamed note keeps its opens, and a note that is gone has none", { skip }, () => {
  const sql = durableSql();
  sql.exec("INSERT INTO ws_rows (id, path, kind) VALUES ('r1', 'old.md', 'file')");
  const opens = workspaceOpens(sql);
  opens.record({ path: "old.md", who: "u_a", by: "person", count: 2 });
  sql.exec("UPDATE ws_rows SET path = 'new.md' WHERE id = 'r1'");
  assert.deepEqual(opens.of({ paths: ["new.md", "old.md"], who: "u_a" }).opens, { "new.md": { mine: 2, people: 2, ai: 0 } });
  sql.exec("UPDATE ws_rows SET gone = 1 WHERE id = 'r1'");
  assert.deepEqual(opens.of({ paths: ["new.md"], who: "u_a" }).opens, {});
  assert.deepEqual(opens.record({ path: "new.md", who: "u_a", by: "person" }), { recorded: false });
});

test("an open that is not one is refused", { skip }, () => {
  const opens = workspaceOpens(durableSql());
  assert.throws(() => opens.record({ path: "a.md", by: "robot" }), OpensRefused);
  assert.throws(() => opens.record({ path: "a.md", by: "person" }), /names who/);
  assert.throws(() => opens.record({ path: "a.md", by: "ai", surface: "fax" }), OpensRefused);
  assert.throws(() => opens.record({ path: "a.md", by: "ai", count: 0 }), OpensRefused);
  assert.throws(() => opens.of({ paths: "a.md" }), OpensRefused);
});

test("an open's weight grows by its logarithm, each count weighed apart, the asker's own counted once", () => {
  const ranking = { openMine: 0.3, openPeople: 0.1, openAi: 0.02 };
  assert.equal(openWeight(undefined, ranking), 1);
  assert.equal(openWeight({ mine: 1, people: 1, ai: 0 }, ranking), 1.3);
  assert.ok(openWeight({ mine: 0, people: 0, ai: 25 }, ranking) < openWeight({ mine: 1, people: 1, ai: 0 }, ranking), "25 AI reads weigh less than one open by you");
  assert.ok(openWeight({ mine: 8, people: 8, ai: 0 }, ranking) < 2, "the eighth open adds less than the first");
});

test("in one workspace, only a note holding every word rises by its opens", () => {
  const hits = [
    { key: "wedding/packing-list.md", title: "Packing list", snippets: [] },
    { key: "trips/lisbon-packing-list.md", title: "Packing list", snippets: [] },
    { key: "index.md", title: "Home", snippets: [], loose: true },
  ];
  const opens = { "trips/lisbon-packing-list.md": { mine: 9, people: 9, ai: 0 }, "index.md": { mine: 40, people: 40, ai: 0 } };
  const ranking = { ...DEFAULT_RANKING, openMine: 0.3, openPeople: 0.1, openAi: 0.02 };
  const rows = byOpens(null, { hits }, opens, ranking);
  assert.deepEqual(rows.map((r) => r.key), ["trips/lisbon-packing-list.md", "wedding/packing-list.md", "index.md"]);
  assert.equal(rows.find((r) => r.key === "index.md").used, undefined, "a loose hit is never lifted");
  // Nothing opened: the rows stand as given, null included.
  assert.equal(byOpens(null, { hits }, {}, ranking), null);
  const merged = mergeLists(hits, [], "key", undefined, ranking, true);
  assert.equal(byOpens(merged, { hits }, {}, ranking), merged);
});

test("across workspaces, a strict hit you opened rises, a meaning-only one does not, and the counts never leave", () => {
  const ranking = { ...FUSE_RANKING, openMine: 0.3, openPeople: 0.1, openAi: 0.02 };
  const wedding = [{ key: "day-of/packing-list.md", title: "Packing list", snippets: [], wordRank: 0, loose: false, meaningScore: 0.6 }];
  const mine = [
    { key: "trips/lisbon-packing-list.md", title: "Packing list", snippets: [], wordRank: 0, loose: false, meaningScore: 0.6, opens: { mine: 9, people: 9, ai: 0 } },
    { key: "index.md", title: "Home", snippets: [], meaningScore: 0.7, opens: { mine: 40, people: 40, ai: 0 } },
  ];
  const plain = fuseEverywhere([wedding, mine.map(({ opens: _o, ...h }) => h)], 10, { query: "packing list", ranking });
  assert.equal(plain[0].key, "day-of/packing-list.md");
  const answer = fuseEverywhere([wedding, mine], 10, { query: "packing list", ranking });
  assert.equal(answer[0].key, "trips/lisbon-packing-list.md");
  assert.ok(answer.every((hit) => !("opens" in hit)), "open counts are a ranking signal, never part of the answer");
  assert.notEqual(answer.findIndex((h) => h.key === "index.md"), 0);
});

test("a read handed back is one AI read on its surface; a refusal or a person's open in the app is logged as such", async () => {
  const recorded = [];
  const deferred = [];
  const store = {
    objectReading: { home: "object", userId: "u_priya", client: { opens: { record: async (o) => recorded.push(o), of: async () => ({ served: true, opens: {} }) } } },
    actor: { userId: "u_priya", clientId: "context_texts", clientName: "Tex" },
    defer: (work) => deferred.push(work),
  };
  countAiRead("read_note", { path: "/trips/packing.md" }, store, { content: [] });
  countAiRead("read_note", { path: "trips/packing.md" }, store, { isError: true });
  countAiRead("search_notes", { query: "x" }, store, { content: [] });
  countAiRead("read_note", { path: "a.md" }, { ...store, actor: { userId: "u_priya", clientId: "claude_ai" } }, { content: [] });
  countPersonOpen({ ...store, actor: { userId: "u_priya", clientId: "context_console" } }, "trips/packing.md");
  await Promise.all(deferred);
  assert.deepEqual(recorded, [
    { path: "trips/packing.md", who: "u_priya", by: "ai", surface: "text", client: "context_texts", clientName: "Tex" },
    { path: "a.md", who: "u_priya", by: "ai", surface: "mcp", client: "claude_ai", clientName: null },
    { path: "trips/packing.md", who: "u_priya", by: "person", surface: "app", client: "context_console" },
  ]);
  // A workspace whose notes are not in its object is asked nothing.
  assert.deepEqual(await opensOf({ objectReading: { home: "bucket" } }, ["a.md"]), {});
});
