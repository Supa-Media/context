/**
 * THE REPLAY GATE'S MODEL HALF (Dev2, 2026-11-13; docs/decisions/testing/replay-gate.md).
 *
 *   pnpm ai gate --base <main checkout> [--areas respond,review] [--held-out <dir>] [--out <file>] [--fake]
 *   pnpm ai gate areas --base-sha <sha>      the areas a change touches, one per line
 *   pnpm ai gate held-out --dir <dir>        the held-out cases from Context (the runner's sign-in)
 *
 * A Tex change runs only the model areas its files reach (`AREAS`): the one
 * judge's reply-or-quiet cases (Clef, a fraction of a cent) and the reply
 * reviewer's cases (Haiku, cents). Plumbing replays are free and run with the
 * gateway's tests; they are not here.
 *
 * Main is never run whole. The change's tree answers every case once; only
 * the cases it gets wrong are run again, twice more on the change and three
 * times on main, and a case regressed when the change is wrong in every one of
 * its three and main right in every one of its three. A case the model gets
 * right only some of the time flips either way on the same code (the first
 * real run, 2026-11-13, saw three such "regressions" in a change that touched
 * no reviewer code), so only a steady flip counts. So a change pays for one full
 * run plus its mistakes, and noise (a case that flips once) is not a
 * regression. The change passes when nothing regressed.
 *
 * Practice cases live in the repository; held-out cases live in Context
 * (`@context-lc ai/held-out/`), are never written to the repository, and are
 * reported by their cause only, so the agent writing a change can't fit to
 * them.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { callTool, notePaths, signIn, splitNote } from "./context.mjs";
import { runCore } from "./coreArea.mjs";

const run = promisify(execFile);

export { AREAS, areasFor } from "./replayAreas.mjs";
import { AREAS, areasFor } from "./replayAreas.mjs";

export const HELD_OUT_FOLDER = "ai/held-out";
export const HELD_OUT_PREFIX = "held-out/";

/** The JSON block of a held-out note (`ai/held-out/<area>.md`), or null. */
export function heldOutJson(text) {
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  return m ? JSON.parse(m[1]) : null;
}

/** A held-out case as a bench case: its id marked, its cause kept, nothing else changed. */
export const markHeldOut = (item) => ({ ...item, id: `${HELD_OUT_PREFIX}${item.id}`, heldOut: true, cause: String(item.cause ?? "unnamed cause") });

/** The held-out cases for an area from a pulled folder, or none. */
export async function readHeldOut(dir, area) {
  if (!dir) return [];
  const text = await readFile(join(dir, `${area}.json`), "utf8").catch(() => null);
  if (text === null) return [];
  const cases = JSON.parse(text).cases ?? [];
  return cases.map(markHeldOut);
}

/** Pull `ai/held-out/<area>.md` from Context into `<dir>/<area>.json`. */
export async function pullHeldOut({ dir, connection, fetchImpl = fetch }) {
  const listed = await callTool(connection, "list_notes", { prefix: HELD_OUT_FOLDER }, fetchImpl);
  if (listed.isError) throw new Error(`list_notes ${HELD_OUT_FOLDER}: ${listed.text}`);
  await mkdir(dir, { recursive: true });
  const pulled = [];
  for (const area of Object.keys(AREAS)) {
    const path = `${HELD_OUT_FOLDER}/${area}.md`;
    if (!notePaths(listed.text).includes(path)) continue;
    const read = await callTool(connection, "read_note", { path }, fetchImpl);
    if (read.isError) throw new Error(`read_note ${path}: ${read.text}`);
    const json = heldOutJson(splitNote(read.text).content);
    if (!json) throw new Error(`${path}: no json block`);
    await writeFile(join(dir, `${area}.json`), JSON.stringify(json), { mode: 0o600 });
    pulled.push(`${area}: ${(json.cases ?? []).length}`);
  }
  return pulled;
}

/** One row per case: whether it came out right, and what a report may say about it. */
export function rowsFor(area, scored) {
  return scored.map((item) => {
    // An advisor role's rows say for themselves (`advisor.mjs` `gateRows`).
    if (typeof item.right === "boolean") return { id: item.id, right: item.right, must: item.must === true, heldOut: item.heldOut === true, cause: item.cause ?? null, target: Boolean(item.target), expected: item.expected ?? "come out right", ...(item.heldOut || typeof item.got !== "string" ? {} : { got: item.got }), ...(Number.isFinite(item.usd) ? { usd: item.usd } : {}) };
    const right = area === "respond" ? (item.want === "hush" ? item.hushed === true : item.hushed === false && item.verdict?.ok === true) : item.fault ? item.sent === false : item.sent === true;
    const expected = area === "respond" ? (item.want === "hush" ? "stay quiet or react" : "reach the model") : item.fault ? "send it back" : "let it go";
    return { id: item.id, right, must: item.must === true, heldOut: item.heldOut === true, target: Boolean(item.target), cause: item.cause ?? null, expected };
  });
}

/**
 * Cases a change got wrong in every run that main got right in every run, and cases main does not have (the change's
 * own new ones) that the change got wrong in most: a change must pass the cases it adds. `runs` maps id to booleans.
 * A case right some of the time on main is the model's coin, not this change's doing, so it never regresses.
 */
export function regressions(branchRuns, mainRuns) {
  const most = (list) => list.filter(Boolean).length * 2 > list.length;
  const every = (list) => list.length > 0 && list.every(Boolean);
  const none = (list) => list.length > 0 && !list.some(Boolean);
  return Object.keys(branchRuns).filter((id) => (mainRuns[id]?.length ? none(branchRuns[id]) && every(mainRuns[id]) : !most(branchRuns[id])));
}

/** The regressed ids that block a merge: a target (`target: "<cause>"`, a known unfixed bug) is reported, never blocks. */
export function blocking(ids, rows) {
  const targets = new Set(rows.filter((row) => row.target).map((row) => row.id));
  return ids.filter((id) => !targets.has(id));
}

/**
 * The feedback the change's author reads: what regressed, what was expected of a practice case, and only the cause
 * of a held-out one, so nothing of a held-out case's words reaches the agent that wrote the change.
 */
export function feedback({ areas, results }) {
  const lines = [];
  const lost = results.flatMap((result) => result.regressed.map((row) => ({ ...row, area: result.area })));
  lines.push(lost.length === 0 ? "## Tex replay: ✅ nothing regressed" : `## Tex replay: ❌ ${lost.length} case(s) regressed against main`, "");
  lines.push(`This change reaches: ${areas.length ? areas.join(", ") : "no model area (plumbing replays only)"}.`, "");
  for (const result of results) {
    const practice = result.rows.filter((row) => !row.heldOut);
    const held = result.rows.filter((row) => row.heldOut);
    const targets = result.rows.filter((row) => row.target);
    if (targets.length) lines.push(`**${result.area} targets** (known bugs, never block): ${targets.filter((row) => row.right).length}/${targets.length} right.`);
    lines.push(`**${result.area}:** practice ${practice.filter((row) => row.right).length}/${practice.length} right, held-out ${held.filter((row) => row.right).length}/${held.length} right; spent about $${result.usd.toFixed(2)}.`);
  }
  lines.push("");
  const practice = lost.filter((row) => !row.heldOut);
  const held = lost.filter((row) => row.heldOut);
  if (practice.length) {
    lines.push("You changed the code these cases run through, and they now fail where main passes:", ...practice.map((row) => `- ${row.area} \`${row.id}\`${row.must ? " (must pass)" : ""}: expected to ${row.expected}${row.got ? `; got ${row.got}` : ""}.`), "");
  }
  if (held.length) {
    const byCause = new Map();
    for (const row of held) byCause.set(`${row.area}: ${row.cause}`, (byCause.get(`${row.area}: ${row.cause}`) ?? 0) + 1);
    lines.push("Held-out cases regressed (their words are never shown; fix the cause, not a case):", ...[...byCause].map(([cause, n]) => `- ${n} about ${cause}`), "");
  }
  if (lost.length) lines.push("Fix the cause in the code or the prompt. Never copy a case's words into a prompt or an example: a check refuses near-copies.", "");
  return lines.join("\n");
}

/** One bench command in a tree, its rows written to a file. `only` limits it to some ids. */
async function benchRows(tree, area, { heldOut, only, fake, out, records = null }) {
  const args = [join(tree, "apps/mcp/bench/run.mjs"), area, "--json", out];
  if (records) args.push("--out", records);
  if (heldOut) args.push("--held-out", heldOut);
  if (only) args.push("--only", only.join(","));
  if (fake) args.push("--fake");
  await run(process.execPath, args, { cwd: tree, maxBuffer: 32 * 1024 * 1024, env: process.env });
  return JSON.parse(await readFile(out, "utf8"));
}

/**
 * What each area may spend and how often its wrong cases run again (on the change, on main). Areas in one pool share
 * its cap: the cheap ones share $1 a change (Dev2, 2026-11-13: "Can we get each change to be less than $1?").
 * `usdPerCase` is a case's price, an estimate where the run does not price itself: Clef is Workers AI, the reviewer
 * one Haiku call, a core question one answer from the production setup plus the judge (measured: spend.md, 2026-11-12).
 */
export const AREA_LIMITS = {
  respond: { maxUsd: 1, pool: "shared", usdPerCase: 0.0002, reruns: { branch: 2, main: 3 } },
  review: { maxUsd: 1, pool: "shared", usdPerCase: 0.002, reruns: { branch: 2, main: 3 } },
  core: { maxUsd: 1, pool: "shared", usdPerCase: 0.005, reruns: { branch: 2, main: 3 } },
  // The advisor's roles are Opus 5.5 at effort high (docs/decisions/testing/advisor-roles.md). AI Gateway put a job
  // check at $0.05 a call and a front door's ask, which reads a whole live turn, at $0.25 (2026-11-06 to 11-13); a
  // case's invented turn is short and its instructions are cached after the first ask. Their rows price themselves
  // (`advisor.mjs`); these estimates stand in only for a row that doesn't. The first real run of all four, 13 cases,
  // spent about $0.58. They share the cheap areas' pool, so no change spends past $1.
  "advisor-chat": { maxUsd: 1, pool: "shared", usdPerCase: 0.06, reruns: { branch: 2, main: 3 } },
  "advisor-job-check": { maxUsd: 1, pool: "shared", usdPerCase: 0.07, reruns: { branch: 2, main: 3 } },
  "advisor-planner": { maxUsd: 1, pool: "shared", usdPerCase: 0.03, reruns: { branch: 2, main: 3 } },
  "advisor-job-mail": { maxUsd: 1, pool: "shared", usdPerCase: 0.04, reruns: { branch: 2, main: 3 } },
  // A job task is a whole background job (its parts, the done check after each, a Haiku quality grade): about $0.35
  // measured (2026-11-13, seven tasks $2.45). It runs only for a change to job or page code, in a pool of its own
  // (the brief: "$1-3 per run"), and a wrong task runs once more on the change and once on main.
  jobs: { maxUsd: 5, pool: "jobs", usdPerCase: 0.35, reruns: { branch: 1, main: 1 } },
};

/** Rows of several runs as one row a case: `results` one boolean a run, `right` when most runs were. */
export function mergeRuns(runs) {
  const byId = new Map();
  for (const rows of runs) {
    for (const row of rows) {
      const seen = byId.get(row.id) ?? { ...row, results: [] };
      seen.results.push(...(row.results ?? [row.right]));
      byId.set(row.id, seen);
    }
  }
  return [...byId.values()].map((row) => ({ ...row, right: row.results.filter(Boolean).length * 2 > row.results.length }));
}

/** A scorer that writes rows (`--json`), run `runs` times: the judge's and the reviewer's areas. */
const benchRunner = (area) => async (tree, { heldOut, only, fake, scratch, tag, runs = 1 }) => {
  const all = [];
  for (let i = 1; i <= runs; i += 1) all.push(await benchRows(tree, area, { heldOut, only, fake, out: join(scratch, `${area}-${tag}-${i}.json`) }));
  const rows = mergeRuns(all);
  // Answered through the model socket (an examiner session, or its recorded answers), a run spends no credits.
  const socketed = Boolean(process.env.BENCH_MODEL_SOCKET || process.env.BENCH_MODEL_REPLAY);
  return { rows, usd: socketed ? 0 : AREA_LIMITS[area].usdPerCase * rows.length * runs };
};

/** An advisor role's scorer (`advisor.mjs`), run `runs` times: its rows price themselves. */
const advisorRunner = (area) => async (tree, { heldOut, only, fake, scratch, tag, runs = 1 }) => {
  const all = [];
  let usd = 0;
  for (let i = 1; i <= runs; i += 1) {
    const rows = await benchRows(tree, area, { heldOut, only, fake, out: join(scratch, `${area}-${tag}-${i}.json`) });
    usd += rows.reduce((sum, row) => sum + (Number.isFinite(row.usd) ? row.usd : AREA_LIMITS[area].usdPerCase), 0);
    all.push(rows);
  }
  return { rows: mergeRuns(all), usd };
};

/**
 * How each area is answered in a tree: `(tree, { heldOut, only, fake, scratch, tag, runs })` -> `{ rows, usd }`, each
 * row with `results` (one boolean a run) and `right`. The core area prices its own answers; it has no held-out cases.
 */
export const RUNNERS = {
  respond: benchRunner("respond"),
  review: benchRunner("review"),
  core: (tree, { only, fake, scratch, tag, runs = 1 }) => runCore(tree, { only, fake, scratch, tag, runs }),
  "advisor-chat": advisorRunner("advisor-chat"),
  "advisor-job-check": advisorRunner("advisor-job-check"),
  "advisor-planner": advisorRunner("advisor-planner"),
  "advisor-job-mail": advisorRunner("advisor-job-mail"),
  jobs: async (tree, { heldOut, only, fake, scratch, tag, runs = 1 }) => {
    const all = [];
    for (let i = 1; i <= runs; i += 1) {
      // Each practice task's page, parts and checks too (`--out`), kept by the workflow so a pass can be read, not trusted.
      all.push(await benchRows(tree, "jobs", { heldOut, only, fake, out: join(scratch, `jobs-${tag}-${i}.json`), records: join(scratch, `jobs-${tag}-${i}-records.json`) }));
    }
    // Each task prices itself (`usd` on its row); a row without one is counted at the estimate.
    const usd = all.flat().reduce((sum, row) => sum + (typeof row.usd === "number" ? row.usd : AREA_LIMITS.jobs.usdPerCase), 0);
    return { rows: mergeRuns(all), usd };
  },
};

/** Whether main's tree has the area at all: a change that adds one gives main no runs, and its cases must pass. */
async function baseHas(base, area) {
  const mod = await import(pathToFileURL(join(base, "apps/mcp/bench/replayAreas.mjs")).href).catch(() => null);
  return Boolean(mod?.AREAS?.[area]);
}

/**
 * The areas whose model calls go through the model socket (`modelSocket.mjs`), so an examiner session can answer
 * them. Another area run with the socket set would call the real models, so it is refused instead.
 */
export const SOCKET_AREAS = new Set(["respond", "review", "core", "advisor-chat", "advisor-job-check", "advisor-planner", "advisor-job-mail"]);

export async function gate({ branch, base, areas, heldOut = null, fake = false, scratch, runners = RUNNERS, limits = AREA_LIMITS, hasArea = baseHas }) {
  const results = [];
  const pools = {};
  let usd = 0;
  const socketed = Boolean(process.env.BENCH_MODEL_SOCKET || process.env.BENCH_MODEL_REPLAY);
  for (const area of areas) if (socketed && !SOCKET_AREAS.has(area)) throw new Error(`the ${area} area can't be answered by an examiner yet: its calls don't go through the model socket`);
  for (const area of areas) {
    const limit = limits[area];
    const runner = runners[area];
    const first = await runner(branch, { heldOut, fake, scratch, tag: "branch-1", runs: 1 });
    const wrongRows = first.rows.filter((row) => !row.right);
    const wrong = wrongRows.map((row) => row.id);
    const perCase = first.rows.length ? first.usd / first.rows.length : limit.usdPerCase;
    const planned = first.usd + perCase * wrong.length * (limit.reruns.branch + limit.reruns.main);
    const spent = pools[limit.pool] ?? 0;
    if (spent + planned > limit.maxUsd) throw new Error(`the ${area} area would take the ${limit.pool} pool past $${limit.maxUsd} (about $${(spent + planned).toFixed(2)}); refused`);
    const branchRuns = Object.fromEntries(wrongRows.map((row) => [row.id, [...(row.results ?? [row.right])]]));
    const mainRuns = Object.fromEntries(wrong.map((id) => [id, []])); // an id main lacks stays empty: the change's own new case
    let cost = first.usd;
    if (wrong.length) {
      const more = await runner(branch, { heldOut, only: wrong, fake, scratch, tag: "branch-2", runs: limit.reruns.branch });
      for (const row of more.rows) branchRuns[row.id]?.push(...row.results);
      cost += more.usd;
      if (await hasArea(base, area)) {
        const onMain = await runner(base, { heldOut, only: wrong, fake, scratch, tag: "main", runs: limit.reruns.main });
        for (const row of onMain.rows) mainRuns[row.id]?.push(...row.results);
        cost += onMain.usd;
      }
    }
    const lost = new Set(blocking(regressions(branchRuns, mainRuns), first.rows));
    pools[limit.pool] = spent + cost;
    usd += cost;
    results.push({ area, rows: first.rows, regressed: first.rows.filter((row) => lost.has(row.id)), usd: cost });
  }
  return { pass: results.every((result) => result.regressed.length === 0), usd, results, report: feedback({ areas, results }) };
}

/** The rows a bench command writes with `--json`. */
export async function writeRows(out, area, scored) {
  await writeFile(out, JSON.stringify(rowsFor(area, scored)));
}

export async function gateCommand(options) {
  const sub = options.job;
  if (sub === "areas") {
    const { stdout } = await run("git", ["diff", "--name-only", options["base-sha"], "HEAD"]);
    process.stdout.write(`${areasFor(stdout.split("\n").filter(Boolean)).join("\n")}\n`);
    return;
  }
  if (sub === "held-out") {
    if (!options.dir) throw new Error("usage: pnpm ai gate held-out --dir <dir>");
    const pulled = await pullHeldOut({ dir: options.dir, connection: await signIn({ env: process.env }) });
    process.stdout.write(`held-out cases pulled: ${pulled.join(", ") || "none"}\n`);
    return;
  }
  if (!options.base) throw new Error("usage: pnpm ai gate --base <main checkout> [--areas a,b]");
  const areas = (options.areas ?? Object.keys(AREAS).join(",")).split(",").filter(Boolean);
  for (const area of areas) if (!AREAS[area]) throw new Error(`no area named ${area}`);
  const scratch = options.scratch ?? join(process.cwd(), ".replay-gate");
  await mkdir(scratch, { recursive: true });
  const result = await gate({ branch: process.cwd(), base: options.base, areas, heldOut: options["held-out"] ?? null, fake: options.fake === true, scratch });
  process.stdout.write(`${result.report}\n`);
  if (options.out) await writeFile(options.out, JSON.stringify({ pass: result.pass, usd: result.usd, report: result.report }));
  if (!result.pass) process.exitCode = 1;
}
