#!/usr/bin/env node
/**
 * The search gate (docs/decisions/search/search-suite.md; Dev2, 2026-11-21: "search code/config changes run the
 * sealed test and can't merge if right-note-first drops").
 *
 * The real-query set's Test part lives only in the sealed eval service (`infra/tex-eval`, the `search_cases` table),
 * beside Tex's Test Set and under the same rules: main's workflows only, by GitHub OIDC, capped, scored by the
 * service, counts only in any log. This script is the CI side:
 *
 *   node scripts/search-test-set.mjs start  --pr <n> --sha <head> --base <main sha> [--change <patch-id>] --dir <sealed dir>
 *       writes <dir>/cases.json and <dir>/run; exit 3 when the caps refuse, with their sentence in <dir>/refused
 *   node scripts/search-test-set.mjs answers --result <result.json> --out <answers.json>
 *       one tree's `cli.mjs search --keep-records` result as { id, rank } rows, the only thing sent back
 *   node scripts/search-test-set.mjs finish --dir <sealed dir>
 *       sends <dir>/branch.json and <dir>/main.json, writes <dir>/verdict.json; exit 0 on a pass, 1 on a fail
 *   node scripts/search-test-set.mjs seed --file <cases.json> --out <file>
 *       the Test part moved in through the seed door; never overwrites
 *   node scripts/search-test-set.mjs pull --out <cases.json>   (the seed workflow, signed in as the benchmark runner)
 *       reads `@context-lc ai/search-held-out/test.md`'s json block, where the Test part waits to be moved in
 *   node scripts/search-test-set.mjs retire    after a seed: that note emptied to a pointer, then archived
 *   node scripts/search-test-set.mjs gate      (in "Tex replay required": BASE_SHA HEAD_SHA GH_TOKEN GITHUB_REPOSITORY)
 *       a change that reaches search passes only on a successful "Search test set" status on its head commit
 *   node scripts/search-test-set.mjs dispatch  (same env, PR_NUMBER): starts "Search test set" on main when needed
 *   node scripts/search-test-set.mjs --self-test
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AUDIENCE = "context-tex-eval";
export const STATUS = "Search test set";
export const WORKFLOW = "search-test-set.yml";
const GATEWAY = process.env.TEX_EVAL_ORIGIN || "https://mcp.context.lc";

/**
 * The files that make search rank what it ranks: the search code, the search tools, the workspace object's indexes,
 * and the search config graph once it lands (`packages/search/`). A change to any of them must not lose the right
 * note first on the sealed Test part. The bench's own harness is main's in the gate, so it is not listed.
 */
export const SEARCH_PATHS = [/^apps\/mcp\/src\/search\//, /^apps\/mcp\/src\/tools\/search(Dates)?\.js$/, /^apps\/mcp\/src\/workspaceStore\/(searchIndex|meaningIndex)\.js$/, /^packages\/search\//];
export const reachesSearch = (files) => files.some((file) => SEARCH_PATHS.some((re) => re.test(file)));

const arg = (name, argv = process.argv) => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 ? argv[i + 1] : undefined;
};
const sealed = (path, value) => {
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
};

async function oidcToken(env = process.env, get = fetch) {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = env;
  if (!url || !bearer) throw new Error("no OIDC token here: the job needs `permissions: id-token: write`");
  const res = await get(`${url}&audience=${AUDIENCE}`, { headers: { authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`GitHub gave no OIDC token (${res.status})`);
  return (await res.json()).value;
}

async function call(path, body, { token, get = fetch } = {}) {
  const res = await get(`${GATEWAY}/tex-eval${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  let answer = null;
  try {
    answer = await res.json();
  } catch {
    answer = null;
  }
  return { status: res.status, answer };
}

/** A tree's result as the rows the service scores: an id and a rank, never a query, a path or a hit. */
export function answersOf(result) {
  return (result?.records ?? []).filter((r) => typeof r?.id === "string").map((r) => ({ id: r.id, rank: Number.isInteger(r.rank) ? r.rank : null }));
}

/** The verdict as lines a log may carry: counts only. */
export function verdictLines(v) {
  return [
    `Search Test part: right note first ${v.first}/${v.total} on the change, ${v.mainFirst}/${v.total} on main: ${v.pass ? "PASS" : "FAIL"}`,
    `- in the top 5: ${v.top5}/${v.total} on the change, ${v.mainTop5}/${v.total} on main`,
  ];
}

/** The status description GitHub shows (140 characters at most). */
export function statusLine(v) {
  if (v.total === 0) return "The search Test part has no cases yet: nothing to gate on";
  return (v.pass ? `Right note first ${v.first}/${v.total}, main ${v.mainFirst}/${v.total}: no drop` : `Right note first dropped: ${v.first}/${v.total}, main ${v.mainFirst}/${v.total}`).slice(0, 140);
}

/** The required check's rule: null to pass, else what is missing. `statuses` are the head commit's, newest first. */
export function gateVerdict(files, statuses) {
  if (!reachesSearch(files)) return null;
  const latest = statuses.find((s) => s.context === STATUS);
  if (latest?.state === "success") return null;
  const how = `This check starts it on main for this pull request (Actions → "${STATUS}", ref main, pr = this number) and is re-run when it ends. Capped like the Tex Test Set: 1 a commit, 10 changes a pull request, 1000 a day.`;
  if (!latest) return `This change reaches search and has no "${STATUS}" run on its head commit. ${how}`;
  return `"${STATUS}" ${latest.state} on this commit: ${latest.description ?? ""} Tune on the Dev part (Lab → Evals → Search, real queries), fix the cause, push. ${how}`;
}

/** Whether to dispatch: only a change that reaches search, with no status on its head commit yet. */
export function dispatchPlan({ files, statuses = [] }) {
  if (!reachesSearch(files)) return { start: false, why: "no file reaches search" };
  const latest = statuses.find((s) => s.context === STATUS);
  if (latest) return { start: false, why: `"${STATUS}" is already ${latest.state} on this commit` };
  return { start: true };
}

/** Where the Test part waits in Context before the seed workflow moves it in, then empties and archives it. */
export const HELD_OUT_NOTE = "ai/search-held-out/test.md";
const MOVED = "# Moved to the search Test part";

/** The cases in a held-out note's ```json block, or null. */
export function casesInNote(body) {
  const m = /```json\n([\s\S]*?)\n```/.exec(String(body ?? ""));
  if (!m) return String(body ?? "").trimStart().startsWith(MOVED) ? [] : null;
  const parsed = JSON.parse(m[1]);
  return Array.isArray(parsed) ? parsed : parsed.cases ?? null;
}

/** A held-out note may name the sha256 of its cases (compact JSON), so a note copied in by hand that lost a byte is refused before it is seeded. */
export function noteCheck(body, cases) {
  const named = /^sha256: ([0-9a-f]{64})$/m.exec(String(body ?? ""))?.[1];
  if (!named) return true;
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex") === named;
}

const gh = (args, inherit) => execFileSync("gh", args, inherit ? { stdio: "inherit" } : { encoding: "utf8" });
const changedFiles = (base) => execFileSync("git", ["diff", "--name-only", base, "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);

async function main() {
  const sub = process.argv[2];
  if (sub === "start") {
    const dir = arg("dir");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { status, answer } = await call("/v1/search/runs", { pr: Number(arg("pr")), sha: arg("sha"), base: arg("base"), ...(arg("change") ? { change: arg("change") } : {}) }, { token: await oidcToken() });
    if (status === 429) {
      sealed(join(dir, "refused"), String(answer?.error ?? "capped"));
      console.log(`The search Test part did not run: ${answer?.error ?? "capped"}.`);
      process.exit(3);
    }
    if (status !== 200 || !answer?.run) throw new Error(`the eval service answered ${status}: ${answer?.error ?? "no run"}`);
    sealed(join(dir, "cases.json"), answer.cases);
    sealed(join(dir, "run"), answer.run);
    console.log(`Search Test part handed over: ${answer.cases.length} cases.`);
    return;
  }
  if (sub === "answers") {
    let result = null;
    try {
      result = JSON.parse(readFileSync(arg("result"), "utf8"));
    } catch {
      result = null; // a tree that wrote nothing answered nothing: every case counts as a miss
    }
    sealed(arg("out"), answersOf(result));
    return;
  }
  if (sub === "finish") {
    const dir = arg("dir");
    const read = (name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        return [];
      }
    };
    const run = readFileSync(join(dir, "run"), "utf8").trim();
    const { status, answer } = await call("/v1/search/runs/result", { run, branch: read("branch.json"), main: read("main.json") }, { token: await oidcToken() });
    if (status !== 200 || !answer?.verdict) throw new Error(`the eval service answered ${status}: ${answer?.error ?? "no verdict"}`);
    writeFileSync(join(dir, "verdict.json"), JSON.stringify(answer.verdict));
    for (const line of verdictLines(answer.verdict)) console.log(line);
    process.exit(answer.verdict.pass ? 0 : 1);
  }
  if (sub === "seed") {
    const cases = JSON.parse(readFileSync(arg("file"), "utf8"));
    const { status, answer } = await call("/v1/search/seed", { cases }, { token: await oidcToken() });
    if (status !== 200) throw new Error(`the eval service answered ${status}: ${answer?.error ?? ""}`);
    writeFileSync(arg("out"), JSON.stringify({ kept: answer.kept, skipped: answer.skipped.length }));
    console.log(`Seeded: ${answer.kept} kept, ${answer.skipped.length} not (already there or unsound). The search Test part now holds ${answer.counts.cases} cases.`);
    return;
  }
  if (sub === "pull" || sub === "retire") {
    const { callTool, signIn, splitNote } = await import("../apps/mcp/bench/context.mjs");
    const connection = await signIn({ env: process.env });
    const read = await callTool(connection, "read_note", { path: HELD_OUT_NOTE });
    if (read.isError) throw new Error(`read_note ${HELD_OUT_NOTE}: ${read.text}`);
    const note = splitNote(read.text);
    if (sub === "pull") {
      const cases = casesInNote(note.content);
      if (!cases) throw new Error(`${HELD_OUT_NOTE}: no json block`);
      if (!noteCheck(note.content, cases)) throw new Error(`${HELD_OUT_NOTE}: its cases do not match the sha256 it names; copy it in again`);
      sealed(arg("out"), cases);
      console.log(`search held-out cases pulled: ${cases.length}`);
      return;
    }
    const content = `${MOVED}\n\nThese cases now live only in the sealed eval service, people only (docs/decisions/search/search-suite.md).\n`;
    const wrote = await callTool(connection, "write_note", { path: HELD_OUT_NOTE, content, summary: "Moved to the search Test part", ...(note.header.etag ? { expected_etag: note.header.etag } : {}) });
    if (wrote.isError) throw new Error(`write_note ${HELD_OUT_NOTE}: ${wrote.text}`);
    const emptied = splitNote((await callTool(connection, "read_note", { path: HELD_OUT_NOTE })).text);
    const archived = await callTool(connection, "archive_note", { path: HELD_OUT_NOTE, ...(emptied.header.etag ? { expected_etag: emptied.header.etag } : {}) });
    if (archived.isError) throw new Error(`archive_note ${HELD_OUT_NOTE}: ${archived.text}`);
    console.log(`emptied and archived ${HELD_OUT_NOTE}`);
    return;
  }
  if (sub === "gate" || sub === "dispatch") {
    const { BASE_SHA, HEAD_SHA, GITHUB_REPOSITORY, PR_NUMBER } = process.env;
    if (!BASE_SHA || !HEAD_SHA) {
      console.log("search gate: not a pull request; nothing to check.");
      return;
    }
    const files = changedFiles(BASE_SHA);
    if (!reachesSearch(files)) {
      console.log("search gate: this change reaches no search code.");
      return;
    }
    const statuses = JSON.parse(gh(["api", `repos/${GITHUB_REPOSITORY}/commits/${HEAD_SHA}/statuses`]));
    if (sub === "gate") {
      const why = gateVerdict(files, statuses);
      if (why) {
        console.error(`::error::${why}`);
        process.exit(1);
      }
      console.log(`search gate: "${STATUS}" passed on this commit.`);
      return;
    }
    const plan = dispatchPlan({ files, statuses });
    if (!plan.start) return console.log(`search gate: not starting (${plan.why}).`);
    const rows = JSON.parse(gh(["run", "list", "--repo", GITHUB_REPOSITORY, "--workflow", WORKFLOW, "--limit", "40", "--json", "displayTitle,status"]));
    if (rows.some((row) => row.displayTitle === `${STATUS} for #${PR_NUMBER}` && ["queued", "in_progress", "waiting", "pending", "requested"].includes(row.status))) return console.log(`search gate: already queued for #${PR_NUMBER}.`);
    gh(["workflow", "run", WORKFLOW, "--repo", GITHUB_REPOSITORY, "--ref", "main", "-f", `pr=${PR_NUMBER}`], true);
    console.log(`search gate: started "${STATUS}" for #${PR_NUMBER}.`);
    return;
  }
  throw new Error("usage: search-test-set.mjs start|answers|finish|seed|gate|dispatch (see the header)");
}

function selfTest() {
  let failed = 0;
  const ok = (name, good) => {
    if (!good) failed += 1;
    console.log(`${good ? "ok" : "FAIL"} - ${name}`);
  };
  const pass = { context: STATUS, state: "success" };
  ok("a search code change reaches search", reachesSearch(["apps/mcp/src/search/priors.js"]));
  ok("the search tool reaches search", reachesSearch(["apps/mcp/src/tools/search.js"]));
  ok("the search config graph reaches search", reachesSearch(["packages/search/src/searchConfig.json"]));
  ok("a Tex prompt does not reach search", !reachesSearch(["packages/tex/src/texPrompt/fd.md", "apps/mcp/src/tools/searchEmail.js"]));
  ok("no search file passes with no run", gateVerdict(["README.md"], []) === null);
  ok("a search change with no run fails", typeof gateVerdict(["apps/mcp/src/search/priors.js"], []) === "string");
  ok("a search change with a pass passes", gateVerdict(["apps/mcp/src/search/priors.js"], [pass]) === null);
  ok("the newest status wins", typeof gateVerdict(["apps/mcp/src/search/priors.js"], [{ context: STATUS, state: "failure" }, pass]) === "string");
  ok("the Tex Test Set's pass is not this one", typeof gateVerdict(["apps/mcp/src/search/priors.js"], [{ context: "Tex test set", state: "success" }]) === "string");
  ok("dispatch starts only without a status", dispatchPlan({ files: ["apps/mcp/src/search/priors.js"] }).start && !dispatchPlan({ files: ["apps/mcp/src/search/priors.js"], statuses: [pass] }).start);
  ok("answers carry an id and a rank only", JSON.stringify(answersOf({ records: [{ id: "a", rank: 1, query: "secret", hits: ["@x/y.md"] }, { id: "b", rank: null }] })) === '[{"id":"a","rank":1},{"id":"b","rank":null}]');
  ok("a drop fails the status line", /dropped/.test(statusLine({ pass: false, total: 10, first: 6, mainFirst: 7, top5: 9, mainTop5: 9 })));
  ok("an empty part says so", /no cases yet/.test(statusLine({ pass: true, total: 0, first: 0, mainFirst: 0, top5: 0, mainTop5: 0 })));
  ok("a held-out note's json block is read", casesInNote("x\n```json\n[{\"id\":\"a\"}]\n```\n").length === 1);
  ok("an emptied held-out note holds no cases", casesInNote(`${MOVED}\n\npointer`).length === 0);
  const named = createHash("sha256").update(JSON.stringify([{ id: "a" }])).digest("hex");
  ok("a note whose cases match its sha256 passes", noteCheck(`sha256: ${named}`, [{ id: "a" }]));
  ok("a note that lost a byte is refused", !noteCheck(`sha256: ${named}`, [{ id: "b" }]));
  if (failed) process.exit(1);
  console.log("\nself-test: all cases behave as stated.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) selfTest();
  else
    main().catch((error) => {
      console.error(`::error::${error.message}`);
      process.exit(2);
    });
}
