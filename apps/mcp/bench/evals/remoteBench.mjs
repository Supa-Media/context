/**
 * A search benchmark asked of the standing bench objects (`packages/lab/gateway/bench/`) on a deployed gateway, every
 * search at once: production's for main, a pull request's preview for its code (`cli.mjs search --remote <origin>`).
 *
 * A world is loaded once and kept there under its key (`remoteWorldKey`): its notes, its people and the code that
 * builds its indexes. A run whose world is already there only searches. Otherwise the first copy is loaded from here,
 * every other copy clones it on its own alarm, and the run waits until every copy has its indexes built.
 *
 * One object answers one search at a time (about 0.4 s for 10,000 notes), so the cases are dealt across `copies`
 * copies of the same notes and asked all together. Only the object path is scored: a bench object is a workspace
 * object, and there is no search database behind it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { benchWorkspaceId, noteIdOf } from "../../../../packages/lab/gateway/bench/world.js";
import { wireSearchSettings } from "../../src/search/settings.js";
import { hitsOf, rankOf } from "../search.mjs";
import { planOf } from "./objectWorld.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The code a kept bench world's indexes were built by: these files and everything they import, in the repository. */
const INDEX_CODE = [
  "apps/mcp/src/workspaceStore/searchIndex.js",
  "apps/mcp/src/workspaceStore/meaningIndex.js",
  "apps/mcp/src/workspaceStore/facts.js",
  "apps/mcp/src/workspaceStore/rows.js",
  "apps/mcp/src/workspaceStore/serveWrites.js",
  "packages/lab/gateway/bench/store.js",
  "packages/lab/gateway/bench/setup.js",
  "packages/lab/gateway/bench/env.js",
];
/** Imports of these are not followed: the bench store's base class reaches the whole gateway. */
const STOP = new Set(["apps/mcp/src/workspaceStore.js"]);

/** Every repository file `entries` import, transitively, themselves included. */
export function importClosure(entries, repo = REPO) {
  const seen = new Set();
  const visit = (file) => {
    const rel = relative(repo, file);
    if (seen.has(rel) || !existsSync(file)) return;
    seen.add(rel);
    if (STOP.has(rel)) return;
    const text = readFileSync(file, "utf8");
    for (const [, spec] of text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) visit(resolve(dirname(file), spec));
  };
  for (const entry of entries) visit(join(repo, entry));
  return [...seen].sort();
}

let indexCode = null;
/** One sha256 over the index code (`INDEX_CODE` and what it imports). */
export function indexCodeHash(repo = REPO) {
  if (indexCode && repo === REPO) return indexCode;
  const hash = createHash("sha256");
  for (const rel of importClosure(INDEX_CODE, repo)) hash.update(`${rel}\0`).update(readFileSync(join(repo, rel))).update("\0");
  const out = hash.digest("hex");
  if (repo === REPO) indexCode = out;
  return out;
}

/** A world's key on the bench objects: its people, its notes and the index code. */
export function remoteWorldKey(bench, repo = REPO) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ people: bench.people, code: indexCodeHash(repo) }));
  for (const name of Object.keys(bench.workspaces).sort()) {
    hash.update(`\0workspace\0${name}`);
    const files = bench.workspaces[name].files;
    for (const path of Object.keys(files).sort()) hash.update(`\0${path}\0${files[path]}`);
  }
  return hash.digest("hex").slice(0, 32);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The bearer token: `BENCH_TOKEN` when set, else GitHub's signed token for the bench when this runs in a workflow
 * job with `id-token: write` (fetched again every four minutes; it lives about ten).
 */
export function tokenSource(env = process.env) {
  let kept = null;
  return async () => {
    if (env.BENCH_TOKEN) return env.BENCH_TOKEN;
    if (kept && Date.now() - kept.at < 240_000) return kept.token;
    if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error("no bench token: set BENCH_TOKEN, or run in a workflow job with id-token: write");
    const response = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=context-bench`, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
    if (!response.ok) throw new Error(`GitHub gave no token (${response.status})`);
    kept = { at: Date.now(), token: (await response.json()).value };
    return kept.token;
  };
}

/** A caller of `POST <origin>/tex-lab/bench`, retrying what a busy deployment refuses. */
export function benchClient(origin, token = tokenSource()) {
  return async function call(body, tries = 4) {
    for (let attempt = 1; ; attempt += 1) {
      let response = null;
      let error = null;
      try {
        response = await fetch(`${origin.replace(/\/$/, "")}/tex-lab/bench`, { method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } catch (caught) {
        error = caught;
      }
      if (response?.ok) return await response.json();
      const said = response ? `${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}` : String(error?.message ?? error);
      if (attempt >= tries || (response && response.status < 500 && response.status !== 429)) throw new Error(`bench ${body.op}: ${said}`);
      await sleep(500 * 2 ** attempt);
    }
  };
}

/** Run `work` over `items`, at most `limit` at a time. */
async function pool(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i], i);
      }
    }),
  );
  return out;
}

/** Notes in pages of at most 400 notes and about 3 MB. */
function pagesOf(notes) {
  const pages = [];
  let page = [];
  let bytes = 0;
  for (const note of notes) {
    if (page.length >= 400 || (page.length > 0 && bytes + note.text.length > 3_000_000)) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(note);
    bytes += note.text.length;
  }
  if (page.length) pages.push(page);
  return pages;
}

/**
 * Make sure `copies` copies of `bench` are loaded and built on the bench objects; answers the world's key. Copies
 * already ready are left as they are.
 */
export async function ensureRemoteWorld(call, bench, { copies, log = () => {}, timeoutMs = 20 * 60_000, poll = 3_000 }) {
  const world = remoteWorldKey(bench);
  const plans = Array.from({ length: copies }, (_, copy) => planOf(bench, (name) => benchWorkspaceId(world, copy, name)));
  const idsOf = (copy) => plans[copy].workspaces.map((w) => w.workspaceId);
  const statusOf = async (copy) => (await call({ op: "status", world, copy, workspaceIds: idsOf(copy) })).workspaces;
  const ready = (status) => Object.values(status).every((s) => s.ready === true);
  const started = Date.now();

  const first = await statusOf(0);
  // A copy is reloaded when it was never set up, or a load stopped before all its notes were in.
  const stale = (status) => Object.values(status).some((s) => !s.set || (s.notes < s.want && !s.cloning));
  if (stale(first)) {
    log(`bench world ${world.slice(0, 8)}: loading copy 1 of ${copies}\n`);
    await call({ op: "setup", world, copy: 0, plan: plans[0] });
    for (const workspace of plans[0].workspaces) {
      const notes = await Promise.all(workspace.files.map(async (path) => ({ key: `notes/${await noteIdOf(workspace.name, path)}.md`, text: bench.workspaces[workspace.name].files[path] })));
      await pool(pagesOf(notes), 4, (page) => call({ op: "notes", world, copy: 0, workspaceId: workspace.workspaceId, notes: page }));
    }
  }
  // The other copies clone the first once it is built, so its embeddings are in the vector cache before they ask:
  // cloning sooner would have every copy embed the same passages at once.
  const waitFor = async (list) => {
    for (let said = 0; ; ) {
      const statuses = await pool(list, 16, statusOf);
      const done = statuses.filter(ready).length;
      if (done === list.length) return;
      if (Date.now() - started > timeoutMs) throw new Error(`bench world ${world.slice(0, 8)}: ${done} of ${list.length} copies built after ${Math.round(timeoutMs / 60_000)} min`);
      if (Date.now() - said > 30_000) {
        said = Date.now();
        const waiting = statuses.flatMap((s) => Object.values(s)).reduce((sum, s) => sum + (s.want - s.notes) + (s.wordsWaiting ?? 0) + (s.meaningWaiting ?? 0), 0);
        log(`bench world ${world.slice(0, 8)}: ${done} of ${list.length} copies built, ${waiting} changes waiting\n`);
      }
      await sleep(poll);
    }
  };
  await waitFor([0]);
  await pool(
    Array.from({ length: copies - 1 }, (_, i) => i + 1),
    8,
    async (copy) => {
      if (!stale(await statusOf(copy))) return;
      await call({ op: "setup", world, copy, plan: plans[copy] });
      for (const workspace of plans[copy].workspaces) await call({ op: "clone", world, copy, workspaceId: workspace.workspaceId, from: plans[0].workspaces.find((w) => w.name === workspace.name).workspaceId });
    },
  );
  await waitFor(Array.from({ length: copies }, (_, copy) => copy));
  if (Date.now() - started > 5_000) log(`bench world ${world.slice(0, 8)}: ${copies} copies ready in ${Math.round((Date.now() - started) / 1000)} s\n`);
  return world;
}

/**
 * The cases of one world, asked of the bench objects at `call`: records as `runSearchCases` makes them, scored on the
 * object path (`path: "objects"`).
 */
export async function runRemoteSearchCases(call, { bench, cases, copies = 16, settings = null, perCall = 4, log = () => {}, poll = 3_000 }) {
  const n = Math.max(1, Math.min(copies, Math.ceil(cases.length / perCall)));
  const world = await ensureRemoteWorld(call, bench, { copies: n, log, poll });
  const personal = new Map(bench.people.filter((row) => row.personal).map((row) => [row.person, row.workspace]));
  const wired = settings ? JSON.stringify(wireSearchSettings(settings)) : null;
  // Case i goes to copy i mod n; each call carries `perCall` cases of one copy, and every call is sent at once.
  const calls = [];
  cases.forEach((c, i) => {
    const copy = i % n;
    const own = personal.get(c.as);
    if (!own) throw new Error(`case ${c.id}: ${c.as} has no personal workspace`);
    const last = calls.findLast((batch) => batch.copy === copy);
    const item = { id: c.id, query: c.query, personal: benchWorkspaceId(world, copy, own), context: c.in ?? null };
    if (last && last.cases.length < perCall) last.cases.push(item);
    else calls.push({ copy, cases: [item] });
  });
  const started = Date.now();
  const answers = new Map();
  await pool(calls, 128, async (batch) => {
    const got = await call({ op: "search", world, copy: batch.copy, cases: batch.cases, ...(wired ? { settings: wired } : {}) });
    for (const answer of got.answers) answers.set(answer.id, answer);
  });
  log(`${cases.length} searches on ${n} copies in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  return cases.map((c) => {
    const answer = answers.get(c.id) ?? { ok: false, text: "no answer", ms: 0 };
    const home = c.in ?? `@${personal.get(c.as)}`;
    const hits = answer.ok ? hitsOf(answer.text, home) : [];
    const rank = (c.expect ?? []).length ? rankOf(hits, c.expect) : null;
    const error = answer.ok ? null : String(answer.text).slice(0, 200);
    return {
      id: c.id,
      query: c.query,
      as: c.as,
      in: c.in ?? null,
      kind: c.kind ?? null,
      expect: c.expect ?? [],
      forbid: c.forbid ?? [],
      hits,
      rank,
      ms: answer.ms,
      path: "objects",
      error,
      // The object path is the only path here: scored as itself (`objectNdcg10`) and as the run's headline.
      object: { hits, rank, ms: answer.ms, path: "objects", object: null, error },
    };
  });
}
