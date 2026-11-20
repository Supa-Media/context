/**
 * THE LAB'S EVALS, KEPT (`LabEvals` in `wrangler.toml`; decision `docs/decisions/texting-assistant/lab-evals.md`).
 *
 * One object, `labevals`, shared by every Tex developer: what each public benchmark's dataset file is (its commit, and
 * where each question's bytes are in it), every run started on one, and each question's result in that run. Public
 * data and Tex's answers to it only: no person's notes, chats or keys. Reached only from `/tex-lab/evals`
 * (`route.js`), which lets in only the developers the Lab's test chats let in. Runs are kept; nothing expires.
 *
 * The object runs one call at a time, so `claim` and `checks` hand each question to one driver even when the Lab and
 * an AI drive the same run at once.
 */

import { objectByName } from "../objectPlace.js";

const ORIGIN = "https://lab-evals.internal";
export const EVALS_NAME = "labevals";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ev_source (bench TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ev_index (bench TEXT NOT NULL, i INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (bench, i))",
  "CREATE TABLE IF NOT EXISTS ev_runs (id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ev_items (run TEXT NOT NULL, qid TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run, qid))",
];

const all = (cursor) => (cursor && typeof cursor.toArray === "function" ? cursor.toArray() : []);
const parsed = (row) => JSON.parse(row.data);

/** The item states: waiting to start, opening its test chat, asked (Tex answering), graded, or failed to run. */
export const ACTIVE = new Set(["opening", "asked"]);
export const FINISHED = new Set(["graded", "failed"]);

export function evalsTables(sql) {
  for (const statement of SCHEMA) sql.exec(statement);
  const itemsOf = (run) => all(sql.exec("SELECT data FROM ev_items WHERE run = ? ORDER BY n", run)).map(parsed);
  const putItem = (run, item) => {
    const old = all(sql.exec("SELECT n, data FROM ev_items WHERE run = ? AND qid = ?", run, item.qid))[0];
    const n = old ? old.n : Number.isSafeInteger(item.n) ? item.n : 0;
    const merged = old ? { ...JSON.parse(old.data), ...item } : item;
    sql.exec("INSERT OR REPLACE INTO ev_items (run, qid, n, data) VALUES (?, ?, ?, ?)", run, item.qid, n, JSON.stringify(merged));
    return merged;
  };
  return {
    source(bench) {
      const row = all(sql.exec("SELECT data FROM ev_source WHERE bench = ?", bench))[0];
      return row ? parsed(row) : null;
    },
    putSource(bench, source, entries) {
      sql.exec("DELETE FROM ev_index WHERE bench = ?", bench);
      entries.forEach((entry, i) => sql.exec("INSERT INTO ev_index (bench, i, data) VALUES (?, ?, ?)", bench, i, JSON.stringify(entry)));
      sql.exec("INSERT OR REPLACE INTO ev_source (bench, data) VALUES (?, ?)", bench, JSON.stringify({ ...source, count: entries.length }));
    },
    index(bench) {
      return all(sql.exec("SELECT data FROM ev_index WHERE bench = ? ORDER BY i", bench)).map(parsed);
    },
    putRun(run) {
      const old = all(sql.exec("SELECT data FROM ev_runs WHERE id = ?", run.id))[0];
      const merged = old ? { ...parsed(old), ...run } : run;
      sql.exec("INSERT OR REPLACE INTO ev_runs (id, at, data) VALUES (?, ?, ?)", run.id, merged.at ?? Date.now(), JSON.stringify(merged));
      return merged;
    },
    run(id) {
      const row = all(sql.exec("SELECT data FROM ev_runs WHERE id = ?", id))[0];
      return row ? parsed(row) : null;
    },
    runs(limit = 50) {
      return all(sql.exec("SELECT data FROM ev_runs ORDER BY at DESC LIMIT ?", limit)).map(parsed);
    },
    removeRun(id) {
      sql.exec("DELETE FROM ev_items WHERE run = ?", id);
      sql.exec("DELETE FROM ev_runs WHERE id = ?", id);
    },
    items: itemsOf,
    putItems(run, items) {
      return items.map((item) => putItem(run, item));
    },
    /**
     * Up to `take` waiting questions, moved to "opening" for one driver, while fewer than `max` are opening or asked.
     * One whose opening went stale (`staleMs`, its driver gone) is failed, so the run never waits on it forever.
     */
    claim(run, { max, take, now, staleMs }) {
      const items = itemsOf(run);
      for (const item of items) if (item.state === "opening" && now - (item.startedAt ?? 0) > staleMs) putItem(run, { qid: item.qid, state: "failed", error: "its test chat never finished opening", doneAt: now });
      const active = itemsOf(run).filter((item) => ACTIVE.has(item.state)).length;
      const room = Math.max(0, Math.min(take, max - active));
      return items.filter((item) => item.state === "waiting").slice(0, room).map((item) => putItem(run, { qid: item.qid, state: "opening", startedAt: now }));
    },
    /** The asked questions no driver is looking at now (`leaseMs`), each leased to this one. */
    checks(run, { now, leaseMs }) {
      return itemsOf(run)
        .filter((item) => item.state === "asked" && now - (item.checkAt ?? 0) > leaseMs)
        .map((item) => putItem(run, { qid: item.qid, checkAt: now }));
    },
  };
}

export function serveEvals(tables, op, body) {
  switch (op) {
    case "source":
      return { source: tables.source(body.bench) };
    case "source.put":
      tables.putSource(body.bench, body.source, Array.isArray(body.entries) ? body.entries : []);
      return { ok: true };
    case "index":
      return { entries: tables.index(body.bench) };
    case "run.put":
      return { run: tables.putRun(body.run) };
    case "run":
      return { run: tables.run(body.id), items: body.items === false ? undefined : tables.items(body.id) };
    case "runs":
      return { runs: tables.runs(Number.isSafeInteger(body.limit) ? Math.min(body.limit, 200) : 50) };
    case "run.remove":
      tables.removeRun(body.id);
      return { ok: true };
    case "items.put":
      return { items: tables.putItems(body.run, Array.isArray(body.items) ? body.items : []) };
    case "claim":
      return { items: tables.claim(body.run, body) };
    case "checks":
      return { items: tables.checks(body.run, body) };
    default:
      return null;
  }
}

/** The one object's stub, or null on a deployment without the binding. */
export function evalsStub(env) {
  const namespace = env?.LAB_EVALS;
  if (!namespace || typeof namespace.idFromName !== "function") return null;
  return objectByName(namespace, EVALS_NAME);
}

/** One call to the object: `op` and its JSON fields, its JSON answer back. */
export async function callEvals(stub, op, fields = {}) {
  const response = await stub.fetch(new Request(`${ORIGIN}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) }));
  if (!response.ok) throw new Error(`lab evals ${op} failed (${response.status})`);
  return await response.json();
}

/** The Durable Object class (`LabEvals` in `wrangler.toml`). */
export class LabEvalsObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.tables = null;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const op = new URL(request.url).pathname.slice(1);
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "bad_call" }, { status: 400 });
    }
    this.tables ??= evalsTables(this.state.storage.sql);
    let answer;
    try {
      answer = serveEvals(this.tables, op, body ?? {});
    } catch (error) {
      return Response.json({ error: "refused", message: String(error?.message ?? "refused").slice(0, 200) }, { status: 422 });
    }
    if (answer === null) return Response.json({ error: "unknown_op" }, { status: 400 });
    return Response.json(answer);
  }
}
