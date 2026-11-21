/**
 * THE SEARCH SUITE: DOES SEARCH PUT THE RIGHT NOTE FIRST? (Dev2, 2026-11-21: "we do need to like start benchmarking
 * our search results ... search quality is abysmal and it's going to affect our agents"; plan "Bench + Search graph +
 * gate", `docs/decisions/search/search-suite.md`.)
 *
 * One harness for every search set the Lab's Evals tab and the search gate run:
 *
 *   search-hard   made-up, harder than `ai/tests/search.md`: a person in seven workspaces, notes that quote the
 *                 question, long notes, archives (`apps/mcp/bench/search/hard/`)
 *   search-real   real searches that failed (nothing opened, or searched again), rewritten, never verbatim, each with
 *                 the notes that make it hard; Training and Dev in `apps/mcp/bench/search/real/`, Test sealed in the
 *                 eval service (`infra/tex-eval`)
 *   longmemeval-retrieval  LongMemEval's past sessions saved as notes; are the answer sessions in the top 5? (no reader,
 *                 no judge; `memoryRetrieval.mjs`)
 *
 * A case is { id, query, as, in?, expect: ["@workspace/path"], forbid?: [...] }. Its notes (`notes`, keyed
 * "@workspace/path") are laid over a copy of the bench's own workspaces, so every case searches a world of many
 * notes, never only its own. Each case is one `search_notes` call as the person through the MCP endpoint, in a warm
 * world with both indexes filled, exactly as the search benchmark (`../search.mjs`) asks. No model but the embedder:
 * a run costs embeddings and seconds.
 *
 * Scored: right note first (the first line is an expected note), in the top 5, found at all, mean reciprocal rank of
 * the first expected note, median and 95th-percentile time.
 */

import { cachedEmbeddings, fakeAi, fakeGateway, workersAi } from "../models.mjs";
import { realNow } from "../clock.mjs";
import { hitsOf, rankOf } from "../search.mjs";
import { prepareRun } from "../warm.mjs";
import { createWorld } from "../world.mjs";
import { createObjectWorld } from "./objectWorld.mjs";

/** A world needs a texting setup note; no word of it reaches a search. */
const PLAIN_TEXTING_SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

/** How deep "in the top 5" looks: what an agent reads of an answer before it opens one. */
export const TOP_K = 5;

/** The sets the suite runs, as the Lab's Evals tab lists them. */
export const SEARCH_SETS = Object.freeze([
  { id: "search-hard", title: "Search", variant: "Made-up hard", about: "Made-up questions in a world of seven workspaces, with notes that quote the question, long notes and archives." },
  { id: "search-real", title: "Search", variant: "Real queries (Dev)", about: "Real searches nobody opened or that were searched again, rewritten; the Dev part (Test is sealed and gates CI)." },
  { id: "longmemeval-retrieval", title: "LongMemEval", variant: "Retrieval", about: "LongMemEval's past sessions saved as notes: are the answer sessions in search's top 5? No reader, no judge." },
]);
export const searchSetOf = (id) => SEARCH_SETS.find((set) => set.id === id) ?? null;

/** "@ws/path" → ["ws", "path"], or null for anything else. */
export function splitAddress(address) {
  const m = /^@([a-z0-9][a-z0-9-]*)\/(.+\.md)$/.exec(String(address ?? ""));
  return m ? [m[1], m[2]] : null;
}

/**
 * The bench with `notes` laid in: each "@ws/path" → text added to that workspace's files (a new workspace is made
 * when `people` names who reaches it). The bench passed in is not changed. Throws on an address that names no
 * workspace and no person, so a typo is a failure and not a case that can never pass.
 */
export function overlay(bench, notes = {}, people = []) {
  const workspaces = Object.fromEntries(Object.entries(bench.workspaces).map(([name, ws]) => [name, { ...ws, files: { ...ws.files }, generated: [...(ws.generated ?? [])] }]));
  const rows = [...bench.people, ...people];
  for (const row of people) {
    if (!workspaces[row.workspace]) workspaces[row.workspace] = { files: {}, heldBack: [], fluff: [], generated: [], calendar: [], mail: [] };
  }
  for (const [address, text] of Object.entries(notes)) {
    const parts = splitAddress(address);
    if (!parts) throw new Error(`not a note address: ${address} (write @workspace/path.md)`);
    const [name, path] = parts;
    if (!workspaces[name]) throw new Error(`${address}: no workspace ${name} in the bench and no person given for it`);
    workspaces[name].files[path] = String(text);
  }
  return { ...bench, people: rows, workspaces };
}

const quantile = (values, q) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const pctOf = (n, of) => (of === 0 ? null : Math.round((1000 * n) / of) / 10);

/**
 * The scores of a set of records: { n, first, top5, found, firstPct, top5Pct, foundPct, mrr, p50Ms, p95Ms, leaks }.
 * A privacy case (nothing expected, some forbidden) is a gate, counted in `leaks`, never in the scores.
 */
export function searchScores(records) {
  const scored = records.filter((r) => (r.expect ?? []).length > 0);
  const leaks = records.filter((r) => (r.forbid ?? []).some((path) => (r.hits ?? []).includes(path))).map((r) => r.id);
  const first = scored.filter((r) => r.rank === 1).length;
  const top5 = scored.filter((r) => r.rank !== null && r.rank <= TOP_K).length;
  const found = scored.filter((r) => r.rank !== null).length;
  const mrr = scored.length === 0 ? 0 : scored.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / scored.length;
  const times = records.map((r) => r.ms).filter((ms) => Number.isFinite(ms));
  return {
    n: scored.length,
    first,
    top5,
    found,
    firstPct: pctOf(first, scored.length),
    top5Pct: pctOf(top5, scored.length),
    foundPct: pctOf(found, scored.length),
    mrr: Math.round(1000 * mrr) / 1000,
    p50Ms: Math.round(quantile(times, 0.5)),
    p95Ms: Math.round(quantile(times, 0.95)),
    errors: records.filter((r) => r.error).length,
    leaks,
    // How many searches each way answered (`pathOf`), so a ranking seen on one path is not read as the other's.
    ...(records.some((r) => r.object) ? { objects: objectScores(records) } : {}),
    byPath: Object.fromEntries([...new Set(records.map((r) => r.path ?? "unknown"))].sort().map((p) => [p, records.filter((r) => (r.path ?? "unknown") === p).length])),
  };
}

/**
 * The same scores for the object world's answers (`record.object`), and how often its rank was the database world's:
 * `same`, `better` (ranked the expected note higher) and `worse`, over the cases both answered.
 */
export function objectScores(records) {
  const both = records.filter((r) => r.object);
  const side = searchScores(both.map(({ object, ...r }) => ({ ...r, ...object })));
  const scored = both.filter((r) => (r.expect ?? []).length > 0);
  const at = (rank) => (rank === null ? Infinity : rank);
  return {
    ...side,
    same: scored.filter((r) => at(r.rank) === at(r.object.rank)).length,
    better: scored.filter((r) => at(r.object.rank) < at(r.rank)).length,
    worse: scored.filter((r) => at(r.object.rank) > at(r.rank)).length,
  };
}

/** The embedder a run uses: Workers AI, or the bench's fake one (`--fake`: words only, no network). */
export function embedderFor({ fake = false, env = process.env } = {}) {
  return fake ? cachedEmbeddings(fakeAi()) : cachedEmbeddings(workersAi(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_AI_TOKEN, env.AI_GATEWAY_ID ?? null));
}

/**
 * Which way one search was answered, from the gateway's own trace line (`search/trace.js`, `event: "search"`): the
 * workspace object's word index (`object`), the search database (`database`), the bucket index (`index`) or a scan
 * (`scan`), with the object's own word when it did not answer (`catching_up`, `unanswered`, `failed`).
 */
export function pathOf(traces) {
  const one = (t) => (t.objectSearch === "served" ? "object" : t.fast === true && t.indexed !== false ? "database" : t.index ? "index" : "scan");
  const paths = [...new Set(traces.map(one))];
  const objects = [...new Set(traces.map((t) => t.objectSearch).filter((w) => typeof w === "string"))];
  // A search across several workspaces writes one line per workspace: the record names each way once.
  return { path: paths.length ? paths.join("+") : null, object: objects.length ? objects.join("+") : null };
}

/** Run `fn` with the gateway's search trace lines caught (and kept off the console). */
async function catchingTraces(fn) {
  const traces = [];
  const log = console.log;
  console.log = (...args) => {
    if (args.length === 1 && typeof args[0] === "string" && args[0].startsWith('{"event":"search"')) {
      try {
        traces.push(JSON.parse(args[0]));
        return;
      } catch {
        // not a trace line after all
      }
    }
    log(...args);
  };
  try {
    return { value: await fn(), traces };
  } finally {
    console.log = log;
  }
}

/**
 * Run `cases` in one warm world built from `bench` (already overlaid and expanded): one record per case, in order.
 * `onRecord(record, i)` hears each as it lands. `settings` is a search setup's settings (`SEARCH_SETTINGS`), null
 * for the code's own. With `objects` (the default), each case is also searched in the object world
 * (`objectWorld.mjs`), the bench's workspaces kept in workspace objects, and the record carries that answer as
 * `object: { hits, rank, ms, path, object }`, so the two ways production answers are compared per query.
 */
export async function runSearchCases({ bench, cases, ai, today = null, settings = null, objects = true, onRecord = () => {}, log = () => {} }) {
  const personal = new Map(bench.people.filter((row) => row.personal).map((row) => [row.person, `@${row.workspace}`]));
  const prepared = await prepareRun(bench, { today, ai });
  const passages = [...prepared.embedded.values()].reduce((total, n) => total + n, 0);
  log(`warmed ${prepared.buckets.size} workspaces, ${passages} passages in their meaning indexes\n`);
  const models = { gatewayFetch: fakeGateway(), ai, ...(settings ? { searchSettings: settings } : {}) };
  const records = [];
  const objectWorld = objects ? await createObjectWorld(bench, { ai, settings }) : null;
  if (objectWorld) log(`object world: ${Object.keys(bench.workspaces).length} workspace objects, both indexes built\n`);
  try {
    for (const [i, c] of cases.entries()) {
      const home = c.in ?? personal.get(c.as);
      if (!home) throw new Error(`case ${c.id}: ${c.as} has no personal workspace`);
      const world = await createWorld(bench, c.as, PLAIN_TEXTING_SETUP, models, today, prepared);
      let record;
      try {
        const started = realNow();
        const { value: answer, traces } = await catchingTraces(() => world.search(c.query, c.in ?? null));
        const hits = answer.ok ? hitsOf(answer.text, home) : [];
        record = {
          id: c.id,
          query: c.query,
          as: c.as,
          in: c.in ?? null,
          kind: c.kind ?? null,
          expect: c.expect ?? [],
          forbid: c.forbid ?? [],
          hits,
          rank: (c.expect ?? []).length ? rankOf(hits, c.expect) : null,
          ms: realNow() - started,
          ...pathOf(traces),
          error: answer.ok ? null : String(answer.text).slice(0, 200),
        };
      } finally {
        world.close();
      }
      if (objectWorld) {
        const started = realNow();
        const { value: answer, traces } = await catchingTraces(() => objectWorld.search(c.as, c.query, c.in ?? null));
        const hits = answer.ok ? hitsOf(answer.text, home) : [];
        record.object = {
          hits,
          rank: record.expect.length ? rankOf(hits, record.expect) : null,
          ms: realNow() - started,
          ...pathOf(traces),
          error: answer.ok ? null : String(answer.text).slice(0, 200),
        };
      }
      records.push(record);
      onRecord(record, i);
      const said = (rank) => (record.expect.length === 0 ? "privacy" : rank === null ? "miss" : `rank ${rank}`);
      log(`${c.id}: ${said(record.rank)}${record.object ? `, object ${said(record.object.rank)}` : ""}\n`);
    }
  } finally {
    prepared.close();
    objectWorld?.close();
  }
  return records;
}

/** A record as the Lab's Evals tab keeps a row (`apps/convex/functions/labEvals.ts` cleanRow). */
export function rowOf(record) {
  return {
    id: record.id,
    type: record.kind ?? "search",
    ability: "search",
    question: record.query,
    expected: record.expect.join(", "),
    date: "",
    answer: record.hits.slice(0, 8).join("\n"),
    correct: record.expect.length ? record.rank === 1 : null,
    rank: record.rank,
    hits: record.hits.length,
    sessions: 0,
    ms: Math.round(record.ms),
    path: record.path ?? null,
    ...(record.object ? { objectRank: record.object.rank, objectPath: record.object.path ?? null } : {}),
    error: record.error,
  };
}
