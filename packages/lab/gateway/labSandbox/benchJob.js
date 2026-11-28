/**
 * A LAB SANDBOX BENCH RUN'S OWN JOB (Seyi, 2026-11-19: "I don't see why we shouldnt be able to run full tests in
 * sandboxes"; plan `products/tex/research/sandbox-bench-scoring-2026-11-19.md`).
 *
 * One Durable Object a run: the `LabSandbox` object named `labsandbox:<userId>:bench-<runId>` (`benchJobStub`). It
 * keeps the run's units (one Front door unit test × one repeat, `labRunSets.mjs` `benchUnits`), the conversation copies
 * it ran, each unit's turn and each unit's judged row. Progress is per unit, so a driver that died resumes where it
 * stopped, and every write is idempotent: a unit's first turn and first row win, a later one is ignored.
 *
 * Unit states: `pending` → `running` (claimed by a step) → `turned` (Tex's turn kept) → `judged` (the driver's row
 * kept). A `running` unit older than `staleMs` is claimable again: the step that claimed it died.
 *
 * The same objects keep the sandbox bench's own budget (`labsandbox:bench:budget`, `takeBenchText`): texts a day for
 * bench runs, never the person's `sends:<day>` count of test texts (`route.js` DAILY_SENDS).
 */

import { objectByName } from "../fromGateway/objectPlace.js";

/** How long a bench job is kept after its last use: a week, so a run can be read back and resumed. */
export const BENCH_TTL_MS = 7 * 24 * 3_600_000;
/** The sandbox bench's texts a day when `LAB_BENCH_DAILY_TEXTS` is not set: its own budget, apart from people's. */
export const BENCH_DAILY_TEXTS = 1_500;
/** A run's id is a Convex id. */
export const RUN_ID = /^[a-z0-9]{16,40}$/;
/** The most units one job keeps (a whole set at five repeats, with room). */
export const MAX_UNITS = 2_000;
/** The largest turn or row kept for one unit (a Durable Object row holds 2 MB). */
export const MAX_UNIT_JSON = 200_000;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS bj_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS bj_convs (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS bj_units (i INTEGER PRIMARY KEY, unit TEXT NOT NULL, state TEXT NOT NULL, claimed_at INTEGER, turn TEXT, row TEXT)",
];
/** Every table a bench job keeps: the alarm and `bench.wipe` delete them all. */
export const BENCH_TABLES = ["bj_meta", "bj_convs", "bj_units"];
const STATES = ["pending", "running", "turned", "judged"];

const all = (cursor) => (cursor && typeof cursor.toArray === "function" ? cursor.toArray() : []);
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The object a run's job lives in: the person's own, named by the run. */
export function benchJobName(userId, runId) {
  return `labsandbox:${userId}:bench-${runId}`;
}

export function benchJobStub(env, userId, runId) {
  const namespace = env?.LAB_SANDBOX;
  if (!namespace || typeof namespace.idFromName !== "function") return null;
  return objectByName(namespace, benchJobName(userId, runId));
}

/** The sandbox bench's budget object: one a deployment. */
export const BENCH_BUDGET_NAME = "labsandbox:bench:budget";
export function benchBudgetStub(env) {
  const namespace = env?.LAB_SANDBOX;
  if (!namespace || typeof namespace.idFromName !== "function") return null;
  return objectByName(namespace, BENCH_BUDGET_NAME);
}

/** The bench's texts a day: `LAB_BENCH_DAILY_TEXTS` when it is a whole number from 0 up, else `BENCH_DAILY_TEXTS`. */
export function benchDailyTexts(env) {
  const raw = env?.LAB_BENCH_DAILY_TEXTS;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,7}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : BENCH_DAILY_TEXTS;
}

/** The bench job's tables over one SQLite handle, and its ops. */
export function benchTables(sql, { now = Date.now } = {}) {
  for (const statement of SCHEMA) sql.exec(statement);
  const meta = () => Object.fromEntries(all(sql.exec("SELECT k, v FROM bj_meta")).map((row) => [row.k, parse(row.v)]));
  const setMeta = (k, v) => sql.exec("INSERT OR REPLACE INTO bj_meta (k, v) VALUES (?, ?)", k, JSON.stringify(v));
  const unitRow = (row) => ({ i: Number(row.i), unit: parse(row.unit), state: row.state, claimedAt: row.claimed_at ?? null, turn: row.turn ? parse(row.turn) : null, row: row.row ? parse(row.row) : null });
  const one = (i) => {
    const found = all(sql.exec("SELECT * FROM bj_units WHERE i = ?", Number(i)))[0];
    return found ? unitRow(found) : null;
  };
  const counts = () => {
    const out = { total: 0, pending: 0, running: 0, turned: 0, judged: 0 };
    for (const row of all(sql.exec("SELECT state, COUNT(*) AS n FROM bj_units GROUP BY state"))) {
      if (STATES.includes(row.state)) out[row.state] = Number(row.n);
      out.total += Number(row.n);
    }
    return out;
  };
  const sized = (value, what) => {
    const text = JSON.stringify(value ?? null);
    if (text.length > MAX_UNIT_JSON) throw new Error(`${what} is over ${MAX_UNIT_JSON} characters`);
    return text;
  };

  return {
    meta,
    wipe() {
      for (const table of BENCH_TABLES) sql.exec(`DELETE FROM ${table}`);
    },
    serve(op, body) {
      switch (op) {
        case "bench.init": {
          const job = body?.job;
          if (!job || typeof job !== "object" || typeof job.runId !== "string" || !RUN_ID.test(job.runId)) throw new Error("a bench job is { job: { runId, ... }, convs, units }");
          const kept = meta().job;
          // The same run again (a driver that lost the answer): nothing changes. Another run never takes this object.
          if (kept) {
            if (kept.runId !== job.runId) throw new Error("this object holds another bench run");
            return { ok: true, existing: true, counts: counts() };
          }
          const units = Array.isArray(body.units) ? body.units : [];
          if (units.length === 0 || units.length > MAX_UNITS) throw new Error(`a bench job has 1 to ${MAX_UNITS} units`);
          for (const c of Array.isArray(body.convs) ? body.convs : []) {
            if (c && typeof c.id === "string") sql.exec("INSERT OR REPLACE INTO bj_convs (id, data) VALUES (?, ?)", c.id, JSON.stringify(c));
          }
          units.forEach((u, i) => sql.exec("INSERT INTO bj_units (i, unit, state) VALUES (?, ?, 'pending')", i, JSON.stringify({ ...u, i })));
          setMeta("job", { ...job, stage: "running" });
          return { ok: true, existing: false, counts: counts() };
        }
        case "bench.status": {
          const units = all(sql.exec("SELECT i, unit, state FROM bj_units ORDER BY i")).map((row) => {
            const u = parse(row.unit) ?? {};
            return { i: Number(row.i), chat: u.chat, msg: u.msg, at: u.at, rep: u.rep, state: row.state };
          });
          return { job: meta().job ?? null, counts: counts(), units };
        }
        case "bench.claim": {
          // The first pending unit, else a running one whose step died (older than `staleMs`).
          const staleMs = Number.isSafeInteger(body?.staleMs) && body.staleMs > 0 ? body.staleMs : 10 * 60_000;
          const at = now();
          const found =
            all(sql.exec("SELECT i FROM bj_units WHERE state = 'pending' ORDER BY i LIMIT 1"))[0] ??
            all(sql.exec("SELECT i FROM bj_units WHERE state = 'running' AND claimed_at < ? ORDER BY i LIMIT 1", at - staleMs))[0];
          if (!found) return { claimed: null, counts: counts() };
          sql.exec("UPDATE bj_units SET state = 'running', claimed_at = ? WHERE i = ?", at, Number(found.i));
          return { claimed: one(found.i), counts: counts() };
        }
        case "bench.release": {
          // A claim given back (the bench budget refused its text): pending again, unless it already turned.
          sql.exec("UPDATE bj_units SET state = 'pending', claimed_at = NULL WHERE i = ? AND state = 'running'", Number(body?.i));
          return { ok: true };
        }
        case "bench.turn": {
          // Only a running unit takes a turn; a later turn for the same unit is ignored (first wins).
          const u = one(body?.i);
          if (!u) throw new Error("there is no such unit");
          if (u.state !== "running") return { ok: false, state: u.state };
          sql.exec("UPDATE bj_units SET state = 'turned', turn = ? WHERE i = ?", sized(body.turn, "a turn"), u.i);
          return { ok: true, state: "turned" };
        }
        case "bench.get": {
          const u = one(body?.i);
          if (!u) throw new Error("there is no such unit");
          return u;
        }
        case "bench.row": {
          // The driver's judged row: only once the unit turned, and the first row wins.
          const u = one(body?.i);
          if (!u) throw new Error("there is no such unit");
          if (u.state === "judged") return { ok: false, state: "judged", counts: counts() };
          if (u.state !== "turned") throw new Error(`unit ${u.i} has not turned yet (${u.state})`);
          sql.exec("UPDATE bj_units SET state = 'judged', row = ? WHERE i = ?", sized(body.row, "a row"), u.i);
          return { ok: true, state: "judged", counts: counts() };
        }
        case "bench.conv": {
          const found = all(sql.exec("SELECT data FROM bj_convs WHERE id = ?", String(body?.id ?? "")))[0];
          return { conv: found ? parse(found.data) : null };
        }
        case "bench.rows":
          return { rows: all(sql.exec("SELECT i, row FROM bj_units WHERE row IS NOT NULL ORDER BY i")).map((row) => parse(row.row)) };
        case "bench.finish": {
          const job = meta().job;
          if (!job) throw new Error("there is no bench job here");
          const stage = body?.stage === "done" ? "done" : "failed";
          // A finished job stays finished.
          if (job.stage === "done" || job.stage === "failed") return { ok: true, unchanged: true, stage: job.stage };
          setMeta("job", { ...job, stage, finishedAt: now() });
          return { ok: true, stage };
        }
        case "bench.budget": {
          // The sandbox bench's own texts a day (this object is `labsandbox:bench:budget`), raised only under `max`.
          const key = typeof body?.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? `budget:${body.day}` : null;
          if (key === null || !Number.isSafeInteger(body?.max)) throw new Error("a budget call is { day, max }");
          const n = Number(meta()[key] ?? 0);
          if (n >= body.max) return { ok: false, n, max: body.max };
          setMeta(key, n + 1);
          return { ok: true, n: n + 1, max: body.max };
        }
        default:
          return null;
      }
    },
  };
}
