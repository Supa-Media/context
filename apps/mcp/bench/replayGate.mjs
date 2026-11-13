/**
 * THE REPLAY GATE'S MODEL HALF (Dev2, 2026-11-13; docs/decisions/testing/replay-gate.md).
 *
 *   pnpm ai gate --base <main checkout> [--areas respond,review,advisor-chat] [--held-out <dir>] [--out <file>] [--fake]
 *   pnpm ai gate areas --base-sha <sha>      the areas a change touches, one per line
 *   pnpm ai gate held-out --dir <dir>        the held-out cases from Context (the runner's sign-in)
 *
 * A Tex change runs only the model areas its files reach (`AREAS`): the one
 * judge's reply-or-quiet cases (Clef, a fraction of a cent), the reply
 * reviewer's cases (Haiku, cents), and each of the advisor's four roles
 * (Opus, cents a case: `advisor.mjs`). Plumbing replays are free and run with
 * the gateway's tests; they are not here.
 *
 * Main is never run whole. The change's tree answers every case once; only
 * the cases it gets wrong are run again, twice more on the change and three
 * times on main, and a case regressed when the change is wrong in most of its
 * three and main right in most of its three. So a change pays for one full
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
import { promisify } from "node:util";

import { callTool, notePaths, signIn, splitNote } from "./context.mjs";

const run = promisify(execFile);

export { AREAS, areasFor } from "./replayAreas.mjs";
import { AREAS } from "./replayAreas.mjs";

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
    if (typeof item.right === "boolean") return { id: item.id, right: item.right, must: item.must === true, heldOut: item.heldOut === true, cause: item.cause ?? null, target: Boolean(item.target), expected: item.expected ?? "come out right" };
    const right = area === "respond" ? (item.want === "hush" ? item.hushed === true : item.hushed === false && item.verdict?.ok === true) : item.fault ? item.sent === false : item.sent === true;
    const expected = area === "respond" ? (item.want === "hush" ? "stay quiet or react" : "reach the model") : item.fault ? "send it back" : "let it go";
    return { id: item.id, right, must: item.must === true, heldOut: item.heldOut === true, cause: item.cause ?? null, expected };
  });
}

/**
 * Cases a change got wrong in most runs that main got right in most, and cases main does not have (the change's own
 * new ones) that the change got wrong in most: a change must pass the cases it adds. `runs` maps id to booleans.
 */
export function regressions(branchRuns, mainRuns) {
  const most = (list) => list.filter(Boolean).length * 2 > list.length;
  return Object.keys(branchRuns).filter((id) => !most(branchRuns[id]) && (!mainRuns[id]?.length || most(mainRuns[id])));
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
    lines.push(`**${result.area}:** practice ${practice.filter((row) => row.right).length}/${practice.length} right, held-out ${held.filter((row) => row.right).length}/${held.length} right; spent about $${result.usd.toFixed(2)}.`);
  }
  lines.push("");
  const practice = lost.filter((row) => !row.heldOut);
  const held = lost.filter((row) => row.heldOut);
  if (practice.length) {
    lines.push("You changed the code these cases run through, and they now fail where main passes:", ...practice.map((row) => `- ${row.area} \`${row.id}\`${row.must ? " (must pass)" : ""}: expected to ${row.expected}.`), "");
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
async function benchRows(tree, area, { heldOut, only, fake, out }) {
  const args = [join(tree, "apps/mcp/bench/run.mjs"), area, "--json", out];
  if (heldOut) args.push("--held-out", heldOut);
  if (only) args.push("--only", only.join(","));
  if (fake) args.push("--fake");
  await run(process.execPath, args, { cwd: tree, maxBuffer: 32 * 1024 * 1024, env: process.env });
  return JSON.parse(await readFile(out, "utf8"));
}

/**
 * Main's rows for an area, or none when main has no such area yet (its bench names no such command: `run.mjs` exits
 * 2 with its usage). Then every case is the change's own, and the change must pass it. Any other failure is thrown.
 */
async function mainRows(base, area, options) {
  try {
    return await benchRows(base, area, options);
  } catch (error) {
    if (error?.code === 2 && /usage: pnpm ai/.test(String(error?.stderr ?? ""))) return [];
    throw error;
  }
}

/** What a run of an area's cases costs, roughly, per case: Clef is Workers AI, the reviewer one Haiku call. */
/**
 * The advisor's roles are Opus 5.5 at effort high: AI Gateway put a job check at $0.05 a call and a front door's ask,
 * which reads a whole turn, at $0.25 (2026-11-06 to 11-13). A case's invented turn is short, and its instructions are
 * cached after the first ask, so a case costs well under a live call. A role's first run is counted at what its rows
 * say it spent when they say (`advisor.mjs`), and only its reruns at these. Their sets are kept small so a change to the shared core, which runs all
 * four, stays inside `MAX_USD` with a case or so to rerun.
 */
export const USD_PER_CASE = { respond: 0.0002, review: 0.002, "advisor-chat": 0.06, "advisor-job-check": 0.04, "advisor-planner": 0.04, "advisor-job-mail": 0.05 };
export const MAX_USD = 1;

export async function gate({ branch, base, areas, heldOut = null, fake = false, scratch }) {
  const results = [];
  let usd = 0;
  for (const area of areas) {
    const first = await benchRows(branch, area, { heldOut, fake, out: join(scratch, `${area}-branch-1.json`) });
    const wrong = first.filter((row) => !row.right).map((row) => row.id);
    // What the first run spent, when its rows say (an advisor role's do), else the plan; its reruns at the plan.
    const measured = first.every((row) => Number.isFinite(row.usd)) && first.length > 0 ? first.reduce((sum, row) => sum + row.usd, 0) : null;
    const planned = (measured ?? USD_PER_CASE[area] * first.length) + USD_PER_CASE[area] * wrong.length * 5;
    if (usd + planned > MAX_USD) throw new Error(`the ${area} area would take the run past $${MAX_USD} (about $${(usd + planned).toFixed(2)}); refused`);
    const branchRuns = Object.fromEntries(wrong.map((id) => [id, [false]]));
    const mainRuns = Object.fromEntries(wrong.map((id) => [id, []])); // an id main lacks stays empty: the change's own new case
    if (wrong.length) {
      for (let i = 2; i <= 3; i += 1) for (const row of await benchRows(branch, area, { heldOut, only: wrong, fake, out: join(scratch, `${area}-branch-${i}.json`) })) branchRuns[row.id]?.push(row.right);
      for (let i = 1; i <= 3; i += 1) for (const row of await mainRows(base, area, { heldOut, only: wrong, fake, out: join(scratch, `${area}-main-${i}.json`) })) mainRuns[row.id]?.push(row.right);
    }
    const lost = new Set(regressions(branchRuns, mainRuns));
    usd += planned;
    results.push({ area, rows: first, regressed: first.filter((row) => lost.has(row.id)), usd: planned });
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
