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
import { WorkspaceStore } from "../../src/workspaceStore.js";
import { MAX_ROWS_PER_PUT, workspaceClient } from "../../src/workspaceStore/api.js";
import { ACCESS_HOMES, objectToken } from "../../src/workspaceStore/access.js";
import { sealBinding } from "../../src/workspaceStore/bindingSeal.js";
import { sha256Hex } from "../../src/controlPlane/index.js";
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
    exec(query, ...binds) {
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
  return { sql, transact, db, close: () => db.close() };
}

/** Workspace objects by name: each the real Durable Object class over its own in-memory SQLite. */
function namespace(env, seeds = new Map()) {
  const objects = new Map();
  return {
    objects,
    idFromName: (name) => ({ name, toString: () => name }),
    get(id) {
      if (!objects.has(id.name)) {
        const { sql, transact, db, close } = durableSqlite(seeds.get(id.name) ?? null);
        const state = {
          id,
          storage: { sql, transactionSync: transact, sync: async () => {}, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} },
          getWebSockets: () => [],
          acceptWebSocket() {},
          setWebSocketAutoResponse() {},
          waitUntil() {},
        };
        const object = new WorkspaceStore(state, env);
        objects.set(id.name, { fetch: (request) => object.fetch(request), object, db, close });
      }
      return objects.get(id.name);
    },
  };
}

/** A stable note id from a workspace and a path: the same note gets the same id on every run. */
async function noteIdOf(workspace, path) {
  const hex = (await sha256Hex(`${workspace}/${path}`)).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

function rowsOf(files, ids) {
  const folders = new Set();
  for (const path of files) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
  }
  const at = 1;
  return [
    ...[...folders].sort().map((path) => ({ id: `d-${path}`, path, kind: "folder", at })),
    ...files.map((path) => ({ id: `f-${ids.get(path)}`, noteId: ids.get(path), path, kind: "file", storageKey: `notes/${ids.get(path)}.md`, etag: `e-${ids.get(path).slice(0, 8)}`, at })),
  ];
}

const call = async (stub, op, fields) =>
  await (await stub.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify(fields) }))).json();

/**
 * Build the object world for `bench` (already overlaid): every workspace in its object with both indexes built, and a
 * connection for each person. `ai` embeds, as in the bucket world. Returns `{ search(person, query, context), close }`.
 */
export async function createObjectWorld(bench, { ai = null, settings = null, log = () => {}, from = null } = {}) {
  const env = {
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

  const people = [...new Set(bench.people.map((row) => row.person))];
  const personal = new Map(bench.people.filter((row) => row.personal).map((row) => [row.person, row.workspace]));
  const userOf = (person) => `user_bench_${person.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

  for (const [name, workspace] of from ? [] : Object.entries(bench.workspaces)) {
    const id = objectWorkspaceId(name);
    const files = Object.keys(workspace.files).filter((path) => path.endsWith(".md"));
    const ids = new Map();
    for (const path of files) ids.set(path, await noteIdOf(name, path));
    const client = workspaceClient(env, id);
    await client.setHome("object");
    await client.setEncryption("none");
    const rules = rulesOf(bench, name);
    await client.rules.put(rules, "member");
    const stub = stubOf(id);
    const store = stub.object.ready();
    store.rows.pinWorkspace(id);
    // A put takes at most MAX_ROWS_PER_PUT rows, as the gateway's own backfill sends them: a public benchmark's
    // corpus is thousands of notes in one workspace.
    const rows = rowsOf(files, ids);
    for (let at = 0; at < rows.length; at += MAX_ROWS_PER_PUT) store.rows.put(rows.slice(at, at + MAX_ROWS_PER_PUT));
    store.rows.putRules(rules);
    for (const path of files) {
      const response = await stub.fetch(new Request("https://tex-store.internal/put", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "put", key: `notes/${ids.get(path)}.md`, options: {} })) }, body: workspace.files[path] }));
      if (response.status !== 200) throw new Error(`${name}/${path}: the object refused the note (${response.status})`);
    }
    const kind = bench.people.some((row) => row.workspace === name && row.personal) ? "personal" : "shared";
    const members = bench.people.filter((row) => row.workspace === name).map((row) => ({ userId: userOf(row.person), personalWorkspaceId: objectWorkspaceId(personal.get(row.person)), role: row.role ?? (row.personal ? "owner" : "member"), groups: [], at: 1 }));
    store.members.put("members", members);
    store.members.setHome("object");
    const answer = {
      binding: { workspaceId: id, provider: "r2", endpoint: "https://s3.bench-objects.invalid", bucket: `bench-objects-${name}`, accessKeyId: `AKIABENCHOBJ${String(name.length).padStart(4, "0")}`, secretAccessKey: "benchObjectSecretNotReal", capabilities: { conditionalWrite: true }, notesHome: "object", status: "active" },
      searchIndex: null,
      meaningIndex: null,
      encryptionKey: null,
      rotation: null,
      noteCap: null,
      managedEncryption: null,
      privacy: rules,
      idLayout: "keys",
      features: {},
      keyed: true,
      kind,
    };
    store.binding.put({ sealed: await sealBinding(answer, { secret: SECRET, workspaceId: id }), at: Date.now(), epoch: store.binding.get().epoch });
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
  for (const person of people) {
    const own = personal.get(person);
    if (!own) continue;
    const pwid = objectWorkspaceId(own);
    const secret = (await sha256Hex(`bench-object-token-${person}`)).slice(0, 43).replace(/[^A-Za-z0-9_-]/g, "a");
    const token = objectToken("access", pwid, secret.padEnd(43, "a"));
    const access = workspaceClient(env, pwid).access;
    await access.pin(userOf(person));
    await access.reach.put(bench.people.filter((row) => row.person === person).map((row) => ({ workspaceId: objectWorkspaceId(row.workspace), slug: row.workspace, kind: row.personal ? "personal" : "shared", role: row.role ?? (row.personal ? "owner" : "member"), groups: [], at: 1 })));
    await access.connections.put([{ grantId: `g_${pwid}`, clientId: "bench-search", clientName: "Bench search", workspaceId: pwid, scopes: ["context:read", "context:private"], tokenHash: await sha256Hex(token), refreshHash: await sha256Hex(`${token}r`), expiresAt: Date.now() + 86_400_000, status: "active", at: 1 }]);
    await access.setHome(ACCESS_HOMES.OBJECT);
    tokens.set(person, token);
  }

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
        return await searchOnce(ctx, settle, token, query, context);
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

  async function searchOnce(ctx, settle, token, query, context) {
      const response = await worker.fetch(
        new Request("https://mcp.bench.invalid/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query, ...(context ? { context } : {}) } } }),
        }),
        env,
        ctx,
      );
      await settle();
      const body = await response.json().catch(() => null);
      const text = (body?.result?.content ?? []).map((block) => block.text ?? "").join("\n");
      return { ok: response.status === 200 && body?.result?.isError !== true, text, status: response.status };
  }
}
