/**
 * The Search suite's second world: the bench's workspaces kept in workspace objects, the way production keeps a
 * workspace whose home is `object` (`docs/decisions/storage-and-credentials/workspace-objects.md`). Each workspace is
 * the real `WorkspaceStore` Durable Object over an in-memory SQLite, with its rows, its notes' text, its access rules,
 * its members, its sealed binding, and its own word and meaning indexes built; each person's own object holds their
 * reach and a connection. A search goes through the gateway's MCP endpoint as that person, as `world.mjs` does for
 * the bucket world, so the object's search path (`search/objectSearch.js`, `meaning/objectMeaning.js`) is what ranks.
 *
 * The bucket world (`world.mjs`) answers from a search database; this one from the objects. Running a case in both is
 * how the two paths are compared per query (`searchSuite.mjs` `runSearchCases`, `paths`).
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import worker from "../../src/index.js";
import { BenchStore } from "../../../../packages/lab/gateway/bench/store.js";
import { benchUserOf } from "../../../../packages/lab/gateway/bench/world.js";
import { searchOnce, setUpPerson, setUpWorkspace } from "../../../../packages/lab/gateway/bench/setup.js";
import { createWorkerCtx } from "../../test/workerCtx.mjs";
import { fixtureVisibility } from "../world.mjs";
import { wireSearchSettings } from "../../src/search/settings.js";

const SECRET = "bench-object-world-gateway-secret-0123456789";
const BUILD_PASSES = 200;

/** An object's SQLite: in memory, or a kept copy's file (`file`, a copy of its own, written to freely). */
function durableSqlite(file = null) {
  const db = new DatabaseSync(file ?? ":memory:");
  if (file) db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF");
  // Each statement prepared once: building a 10,000-note world prepares the same few hundred thousand times.
  const statements = new Map();
  const sql = {
    exec(query, ...values) {
      // A Durable Object's SQL takes an ArrayBuffer for a blob; node's takes bytes.
      const binds = values.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value));
      if (!statements.has(query)) {
        if (statements.size >= 2_000) statements.clear(); // a query built with a varying IN list stays bounded
        statements.set(query, db.prepare(query));
      }
      const statement = statements.get(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
  const transact = (work) => {
    db.exec("BEGIN");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return { sql, transact, db, forget: () => statements.clear(), close: () => db.close() };
}

/**
 * Workspace objects by name: each the bench's Durable Object class (`BenchStore`, the gateway's `WorkspaceStore` in a
 * bench environment) over its own in-memory SQLite. `alarms` keeps the time each object last armed its alarm.
 */
export function namespace(env, seeds = new Map()) {
  const objects = new Map();
  const alarms = new Map();
  return {
    objects,
    alarms,
    idFromName: (name) => ({ name, toString: () => name }),
    get(id) {
      if (!objects.has(id.name)) {
        const { sql, transact, db, forget, close } = durableSqlite(seeds.get(id.name) ?? null);
        const state = {
          id,
          storage: {
            sql,
            transactionSync: transact,
            sync: async () => {},
            getAlarm: async () => null,
            setAlarm: async (at) => void alarms.set(id.name, at),
            deleteAlarm: async () => void alarms.delete(id.name),
            deleteAll: async () => {
              // Virtual tables first: dropping one drops its shadow tables with it.
              for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY sql LIKE 'CREATE VIRTUAL%' DESC").all()) db.exec(`DROP TABLE IF EXISTS "${name}"`);
              forget();
            },
          },
          getWebSockets: () => [],
          acceptWebSocket() {},
          setWebSocketAutoResponse() {},
          waitUntil() {},
        };
        const object = new BenchStore(state, env);
        objects.set(id.name, { fetch: (request) => object.fetch(request), object, db, close });
      }
      return objects.get(id.name);
    },
  };
}

const objectWorkspaceId = (name) => `wo_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** The rules a fixture workspace is read under: a personal one's notes are private, a shared one's team unless held back. */
function rulesOf(bench, name) {
  const files = Object.keys(bench.workspaces[name].files);
  const tops = [...new Set(files.filter((path) => path.includes("/")).map((path) => path.split("/")[0]))];
  const vis = (path) => fixtureVisibility(bench, name, path);
  const shared = vis("__probe__.md") === "team";
  return {
    etag: `bench.${name}`,
    accessVersion: 1,
    folders: shared ? tops.map((prefix) => ({ prefix, visibility: "team" })) : [],
    notes: files.filter((path) => (shared ? vis(path) === "private" || !path.includes("/") : false)).map((path) => ({ path, visibility: vis(path) })),
  };
}

const call = async (stub, op, fields) =>
  await (await stub.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify(fields) }))).json();

/**
 * What a bench world sets up (`packages/lab/gateway/bench/setup.js`): each workspace's notes, rules and members under
 * the id `idOf(name)` gives it, and each person with a personal workspace, their reach and their user id. The local
 * object world and the standing bench objects (`remoteBench.mjs`) set up the same plan.
 */
export function planOf(bench, idOf) {
  const personal = new Map(bench.people.filter((row) => row.personal).map((row) => [row.person, row.workspace]));
  const roleOf = (row) => row.role ?? (row.personal ? "owner" : "member");
  const workspaces = Object.entries(bench.workspaces).map(([name, workspace]) => ({
    workspaceId: idOf(name),
    name,
    kind: bench.people.some((row) => row.workspace === name && row.personal) ? "personal" : "shared",
    files: Object.keys(workspace.files).filter((path) => path.endsWith(".md")),
    rules: rulesOf(bench, name),
    members: bench.people.filter((row) => row.workspace === name).map((row) => ({ userId: benchUserOf(row.person), personalWorkspaceId: idOf(personal.get(row.person)), role: roleOf(row), groups: [], at: 1 })),
    // Its open history (`overlay`): an AI client's reads under no one, a person's under their bench user id.
    opens: (workspace.opens ?? []).map(({ path, who, count }) => (who === "ai" ? { path, by: "ai", count } : { path, who: benchUserOf(who), by: "person", count })),
  }));
  const people = [...new Set(bench.people.map((row) => row.person))]
    .filter((person) => personal.has(person))
    .map((person) => ({
      person,
      personalWorkspaceId: idOf(personal.get(person)),
      userId: benchUserOf(person),
      reach: bench.people.filter((row) => row.person === person).map((row) => ({ workspaceId: idOf(row.workspace), slug: row.workspace, kind: row.personal ? "personal" : "shared", role: roleOf(row), groups: [], at: 1 })),
    }));
  return { workspaces, people };
}

/**
 * Build the object world for `bench` (already overlaid): every workspace in its object with both indexes built, and a
 * connection for each person. `ai` embeds, as in the bucket world. Returns `{ search(person, query, context), close }`.
 */
export async function createObjectWorld(bench, { ai = null, settings = null, log = () => {}, from = null } = {}) {
  const env = {
    // Already a bench environment (`packages/lab/gateway/bench/env.js`): each object is a `BenchStore` over it as is.
    BENCH_WORLD: true,
    GATEWAY_SECRET: SECRET,
    CONTROL_PLANE_URL: "https://control.bench.invalid",
    CONTROL_PLANE_SECRET: "b".repeat(40),
    SEARCH_SUBREQUEST_BUDGET: "600",
    ...(ai ? { AI: ai } : {}),
    // A Lab draft's search settings, as the bucket world passes them (`world.mjs`).
    ...(settings ? { SEARCH_SETTINGS: JSON.stringify(wireSearchSettings(settings)) } : {}),
  };
  // `from`: a folder `save` wrote. Each object opens a copy of its kept SQLite, so nothing is put or indexed again.
  const copies = from ? mkdtempSync(join(tmpdir(), "bench-objects-")) : null;
  const seeds = new Map();
  if (from) {
    const names = JSON.parse(readFileSync(join(from, "objects.json"), "utf8"));
    names.forEach((name, i) => {
      const file = join(copies, `${i}.db`);
      copyFileSync(join(from, `${i}.db`), file);
      seeds.set(name, file);
    });
  }
  const ns = namespace(env, seeds);
  env.WORKSPACE_STORE = ns;
  const stubOf = (id) => ns.get(ns.idFromName(`workspace:${id}`));

  const plan = planOf(bench, objectWorkspaceId);
  for (const workspace of from ? [] : plan.workspaces) {
    const { workspaceId: id, name, files } = workspace;
    const { ids } = await setUpWorkspace(env, workspace);
    const stub = stubOf(id);
    for (const path of files) {
      const response = await stub.fetch(new Request("https://tex-store.internal/put", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "put", key: `notes/${ids[path]}.md`, options: {} })) }, body: bench.workspaces[name].files[path] }));
      if (response.status !== 200) throw new Error(`${name}/${path}: the object refused the note (${response.status})`);
    }
    let waiting = 0;
    for (const op of ["ws.search.build", "ws.meaning.build"]) {
      // A pass indexes a bounded number of notes, so a large world (HERB's 40,000) takes as many passes as it needs;
      // the run fails only when BUILD_PASSES passes in a row index nothing.
      let stuck = 0;
      for (let before = Infinity; stuck < BUILD_PASSES; ) {
        const built = await call(stub, op, { workspaceId: id });
        waiting = built?.waiting ?? 0;
        if (!(waiting > 0)) break;
        stuck = waiting < before ? 0 : stuck + 1;
        before = Math.min(before, waiting);
      }
      if (waiting > 0) throw new Error(`${name}: ${op} still has ${waiting} waiting after ${BUILD_PASSES} passes with no progress`);
    }
    log(`object ${name}: ${files.length} notes, both indexes built\n`);
  }

  const tokens = new Map();
  for (const person of plan.people) tokens.set(person.person, await setUpPerson(env, person));

  return {
    /** One `search_notes` as `person`, through the MCP endpoint, as `world.mjs` `search` does. */
    async search(person, query, context = null) {
      const token = tokens.get(person);
      if (!token) throw new Error(`${person} has no personal workspace in the object world`);
      const { ctx, settle } = createWorkerCtx();
      // This world has no control plane: the gateway's "could not tell the control plane" lines are dropped here,
      // and every other line (the search trace among them) passes on.
      const log = console.log;
      console.log = (...args) => {
        if (typeof args[0] === "string" && args[0].startsWith('{"event":"control_plane_failed"')) return;
        log(...args);
      };
      try {
        const answer = await searchOnce((request, env) => worker.fetch(request, env, ctx), env, token, query, context);
        await settle();
        return answer;
      } finally {
        console.log = log;
      }
    },
    /** Keep every object's SQLite in `dir` (which must be empty or new), for `from` to open next run. */
    save(dir) {
      const names = [...ns.objects.keys()];
      names.forEach((name, i) => ns.objects.get(name).db.exec(`VACUUM INTO '${join(dir, `${i}.db`).replaceAll("'", "''")}'`));
      writeFileSync(join(dir, "objects.json"), JSON.stringify(names));
    },
    close() {
      for (const { close } of ns.objects.values()) close();
      if (copies) rmSync(copies, { recursive: true, force: true });
    },
  };
}
