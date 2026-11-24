#!/usr/bin/env node
/**
 * THE TEX DIAGRAM IS TEX'S CONFIG (Dev2, 2026-11-05: "any change to the architecture must change the diagram";
 * 2026-11-14: the connections between nodes are config, never code, and Tex is told its own structure from it).
 *
 * `packages/tex/src/texConfig.json` is what Tex runs, and `docs/architecture/tex.md`'s drawing and table and the
 * map every Tex agent reads (`texArchitecture.generated.js`) are generated from it (`tex-architecture.mjs`). This
 * checks the code against the config, so code that runs outside it fails CI:
 *
 *   1. The page and the map are exactly what the config makes, and every wire joins two nodes with a known mode.
 *   2. Every step `texEntryPoint.js` runs is a node of the config, or named by a node's file, and the steps that are
 *      nodes are in the config in the order the code runs them.
 *   3. Every file under the scanned folders that names a model (a Claude, Cloudflare or Gemini model id) is a node's
 *      file, or on one of two short lists below: PLUMBING (carries model calls for nodes, never one itself) or
 *      NOT_NODED_YET (a model call still waiting for its node; the list only shrinks, and a file that has its node or
 *      no longer names a model must leave it).
 *   4. Every Tex agent's system prompt goes through `withArchitecture`, so it carries the map.
 *   5. With `--base <sha>` (a pull request): a change to `texEntryPoint.js`, a file under `texEntryPoint/`, or any
 *      node's file must change the config too, unless the pull request's description (env `TEX_PR_BODY`) has a line
 *      `Tex diagram: unchanged because <reason>`.
 *   7. Every file under `packages/tex/gateway/agent` that turns the model back with words of its own (a code send-back
 *      or hold: it exports a `…_NOTICE` constant, or a `…Notice`, `…Check`, `…Gate`, `…Judge` or `…Hold` function) is
 *      a node's file, a shelf node's file, or on CODE_CHECKS_NOT_NODED_YET (Dev2, 2026-11-14: "every model call and
 *      code branch in or around a turn must be a config node"). Found 2026-11-22: #3614 refused a check-in's first
 *      `say_nothing` from a word list in a new file, and no check saw it, because it named no model. The list only
 *      shrinks: a new hold gets a node (or goes in an existing node's file), never a line here.
 *   6. Every step the Lab's test chat records by a name of its own (`packages/lab/gateway/labSandbox/`: `book.line("x"` and
 *      `book.begin({ node: "x"`) is a node of the config, or one of `LAB_TRANSPORT`, the simulated phone line a test
 *      text goes over (Dev2, 2026-11-16: "pretend it's a Photon iMessage thing"). Those are the sandbox's transport, not
 *      Tex: none may be a node id, and the list in `labSandbox/steps.js` (`TRANSPORT_STEPS`) must be this one.
 *
 * Usage:
 *   node scripts/tex-diagram-check.mjs                 checks 1 to 4
 *   node scripts/tex-diagram-check.mjs --base <sha>    also check 5, against that commit
 *   node scripts/tex-diagram-check.mjs --self-test
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, PAGE as DIAGRAM, generatedProblems } from "./tex-architecture.mjs";
import { FOLDER as PROMPT_FOLDER, MODULE as PROMPT_MODULE, moduleIsCurrent as promptIsCurrent } from "./tex-prompt-module.mjs";
import { FOLDER as TRAINING_FOLDER, MODULE as TRAINING_MODULE, moduleIsCurrent as trainingIsCurrent } from "./tex-training-module.mjs";
import { NIGHTLY_PATH, joinedTexConfig, readTexConfig } from "./lib/texConfigFile.mjs";
import { mergedOnto } from "./check-tex-change-has-case.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export { DIAGRAM };
const ENTRY = "packages/tex/gateway/agent/texEntryPoint.js";
const STEPS_DIR = "packages/tex/gateway/agent/texEntryPoint/";
/** Where a model may be named; each file that names one is a node's file, or on a list below. */
const MODEL_FOLDERS = ["packages/tex/gateway/agent", "packages/tex/worker", "apps/convex/functions/lib/jev"];
/** Where a node's file is looked for, by its path's end: the gateway's agent moved to packages/tex/gateway (2026-11-20), and check 5 watched only its old home until 2026-11-22. */
const NAMED_FOLDERS = ["apps/mcp/src", "packages/tex/gateway", "packages/tex/worker", "apps/convex/functions/lib/jev"];
const MODEL_ID = /["'`](?:anthropic\/claude-[a-z0-9.-]+|@cf\/[a-z0-9._-]+\/[a-z0-9._-]+|gemini-[a-z0-9.-]+)["'`]/;
/** Files that name a model to carry or price calls for nodes, and are never a model call of their own. */
export const PLUMBING = Object.freeze({
  "packages/tex/gateway/agent/production.js": "reads the texting setup, whose models are the config's",
  "apps/convex/functions/lib/jev/models.ts": "the control plane's table of models the meter knows",
  "apps/convex/functions/lib/jev/meter.ts": "prices each model's tokens for usage rows",
});
/**
 * Model calls that run today without a node of their own (Dev2, 2026-11-14: "every model call and code branch in or
 * around a turn must be a config node"). Each is being given its node; the list only shrinks.
 */
export const NOT_NODED_YET = Object.freeze({
  "packages/tex/gateway/agent/decide.js": "Clef's small choices on a person's computer",
});
/** A code send-back or hold: a notice the model loop is handed, or a function that decides one (check 7). */
const HOLDS = /export\s+(?:const\s+[A-Z0-9_]*NOTICE\b|(?:async\s+)?function\s+\w*(?:Notice|Check|Gate|Judge|Hold)\s*\()/;
/**
 * Code send-backs and holds that run today inside the Front door's loop or the Answer check without a node of their
 * own (check 7; paths under packages/tex/gateway/agent). Each is waiting for its node, or for its node's file to name
 * it; the list only shrinks.
 */
export const CODE_CHECKS_NOT_NODED_YET = Object.freeze([
  "lastRound.js",
  "ledger.js",
  "lookFirst.js",
  "pageCoverFloor.js",
  "progress.js",
  "readClaims.js",
  "recordRead.js",
  "saveAccount.js",
  "searchClaims.js",
  "timeLog.js",
]);
/** Where a Tex agent's prompt is written: each file here that gives a model a system prompt puts the map ahead of it (`texArchitecture.js`). */
const AGENT_FOLDER = "packages/tex/gateway/agent";
/** Files that carry a system prompt without writing one: the transport, the day told at its door (`withToday`), the turn that sends runTheModel's prompt, and a card template's field named system. */
const PROMPT_CARRIERS = new Set(["aiGateway.js", "builtin.js", "turn.js", "turnPrompt.js", "visuals/index.js", "texArchitecture.js", "localNow.js"]);
const GIVES_A_PROMPT = /\bsystem:\s*(?!\[)/;
const WITH_MAP = /\b(?:withArchitecture|architectureFor)\(/;
const UNCHANGED = /^\s*Tex diagram: unchanged because \S.{3,}/im;

/** The Lab test chat's own steps that are no node of the config: its simulated phone line, in and out (`labSandbox/line.js`). */
export const LAB_TRANSPORT = Object.freeze(["lineIn", "lineOut"]);
const LAB_FOLDER = "packages/lab/gateway/labSandbox";
const LAB_STEP = /\bbook\.(?:line\(\s*"([A-Za-z]+)"|begin\(\s*\{\s*node:\s*"([A-Za-z]+)")/g;
const LAB_LIST = /TRANSPORT_STEPS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/;

/**
 * Problems with the Lab test chat's own step names (`files`: `{ path, source }` under `LAB_FOLDER`): one that is neither
 * a node nor transport, transport that became a node, or a transport list in the code that is not `LAB_TRANSPORT`.
 */
export function transportProblems(files, config, transport = LAB_TRANSPORT) {
  const ids = new Set(config.nodes.map((n) => n.id));
  const problems = [];
  for (const name of transport) if (ids.has(name)) problems.push(`${name} is the Lab's simulated line, not Tex, but ${CONFIG} has a node by that name: rename one`);
  for (const { path, source } of files) {
    for (const match of source.matchAll(LAB_STEP)) {
      const name = match[1] ?? match[2];
      if (!ids.has(name) && !transport.includes(name)) problems.push(`${LAB_FOLDER}/${path} records a step "${name}" that is no node of ${CONFIG} and not the Lab's transport (LAB_TRANSPORT in scripts/tex-diagram-check.mjs)`);
    }
    const listed = source.match(LAB_LIST);
    if (listed) {
      const names = [...listed[1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
      if (names.join() !== transport.join()) problems.push(`${LAB_FOLDER}/${path} lists the transport steps as ${names.join(", ")}, not ${transport.join(", ")}: change both or neither`);
    }
  }
  return problems;
}

/** Problems with the agents' prompts: one that gives a model a system prompt without the drawing. */
export function mapProblems(files) {
  return files.filter(({ path, source }) => !PROMPT_CARRIERS.has(path) && GIVES_A_PROMPT.test(source) && !WITH_MAP.test(source)).map(({ path }) => `${AGENT_FOLDER}/${path} gives a model a system prompt without the map: pass it through withArchitecture (texArchitecture.js) with its role`);
}

/**
 * The steps a turn runs, in order, now that it runs the config's graph (`packages/tex/gateway/agent/graph/turnGraph.js`): for
 * each node of `texConfig.json`, in the config's order, the `texEntryPoint/` step files its gateway node's code runs,
 * then each `steps.<name>(t` the entry file still calls itself (its failure path).
 */
export function graphSteps(root) {
  const config = readTexConfig(root);
  const table = readFileSync(join(root, "packages/tex/gateway/agent/graph/gatewayNodes.js"), "utf8");
  const fileOf = new Map([...table.matchAll(/import \{ (\w+) \} from "\.\/nodes\/([\w-]+)\.js";/g)].map((m) => [m[1], m[2]]));
  const steps = [];
  for (const { id } of config.nodes) {
    const impl = table.match(new RegExp(`^\\s+${id}: (\\w+),`, "m"))?.[1];
    const file = impl ? fileOf.get(impl) : null;
    if (!file) continue;
    const source = readFileSync(join(root, "packages/tex/gateway/agent/graph/nodes", `${file}.js`), "utf8");
    for (const m of source.matchAll(/from "\.\.\/\.\.\/texEntryPoint\/(\w+)\.js"/g)) if (!steps.includes(m[1])) steps.push(m[1]);
  }
  for (const step of codeSteps(readFileSync(join(root, ENTRY), "utf8"))) if (!steps.includes(step)) steps.push(step);
  return steps;
}

/** The steps the code runs, in order: each `steps.<name>(t` in the entry file. */
export function codeSteps(source) {
  return [...source.matchAll(/\bsteps\.([a-zA-Z]+)\(t\b/g)].map((match) => match[1]);
}

/** Problems with the steps: one the config has no node for, or nodes in another order than the code runs them. */
export function stepProblems(code, config) {
  const ids = config.nodes.map((n) => n.id);
  const files = config.nodes.map((n) => n.file ?? "").join(" · ");
  const problems = [];
  for (const name of code) if (!ids.includes(name) && !new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(files)) problems.push(`step ${name} runs in ${ENTRY} but no node of ${CONFIG} is it or names it in its file`);
  const both = code.filter((name) => ids.includes(name));
  const order = ids.filter((id) => both.includes(id));
  if (problems.length === 0 && both.join() !== order.join()) problems.push(`${CONFIG} has the steps in another order than ${ENTRY} runs them: ${both.join(" → ")}`);
  return problems;
}

/** Problems with the files that name a model: one no node names and no list holds, or a list entry that is stale. */
export function modelFileProblems(naming, config, shelfFiles = []) {
  const files = config.nodes.map((n) => n.file ?? "").join(" · ");
  // A shelf node's files (merged, not wired, never run; Dev2, 2026-11-16) are a node's files too.
  const named = (path) => pageNames(files, path) || shelfFiles.includes(path);
  const problems = [];
  for (const path of naming) if (!named(path) && !(path in PLUMBING) && !(path in NOT_NODED_YET)) problems.push(`${path} names a model but is no node's file in ${CONFIG}: give its model call a node (or, if it only carries calls for nodes, add it to PLUMBING with why)`);
  for (const path of Object.keys(NOT_NODED_YET)) {
    if (named(path)) problems.push(`${path} is a node's file now: take it off NOT_NODED_YET in scripts/tex-diagram-check.mjs`);
    else if (!naming.includes(path)) problems.push(`${path} no longer names a model: take it off NOT_NODED_YET in scripts/tex-diagram-check.mjs`);
  }
  return problems;
}

/**
 * Problems with the files that turn the model back (`holding`: their paths under `AGENT_FOLDER`): one no node names, the
 * shelf does not hold and the list does not hold, or a list entry that is stale (it has its node, or holds nothing now).
 */
export function holdProblems(holding, config, shelfFiles = [], listed = CODE_CHECKS_NOT_NODED_YET) {
  const files = config.nodes.map((n) => n.file ?? "").join(" · ");
  const named = (path) => pageNames(files, path) || shelfFiles.includes(`${AGENT_FOLDER}/${path}`);
  const problems = [];
  for (const path of holding) {
    if (path.startsWith("graph/nodes/") || named(path) || listed.includes(path)) continue;
    problems.push(`${AGENT_FOLDER}/${path} turns the model back with words of its own (a code send-back or hold) but is no node's file in ${CONFIG}: give it a node, or put it in the file of the node that runs it (Dev2, 2026-11-14: every code branch in a turn is a config node)`);
  }
  for (const path of listed) {
    if (named(path)) problems.push(`${AGENT_FOLDER}/${path} is a node's file now: take it off CODE_CHECKS_NOT_NODED_YET in scripts/tex-diagram-check.mjs`);
    else if (!holding.includes(path)) problems.push(`${AGENT_FOLDER}/${path} holds nothing now (or is gone): take it off CODE_CHECKS_NOT_NODED_YET in scripts/tex-diagram-check.mjs`);
  }
  return problems;
}

/** Whether a page names a file: its name, as a whole word, anywhere on it. */
export function pageNames(page, path) {
  const base = path.split("/").pop();
  return new RegExp(`(^|[^A-Za-z0-9_.-])${base.replace(/[.]/g, "\\.")}($|[^A-Za-z0-9_-])`).test(page);
}

/** The file names the config's nodes give (`name.js`, `dir/name.ts`), as written. */
export function namedFiles(config) {
  const text = config.nodes.map((n) => n.file ?? "").join(" · ");
  return [...new Set([...text.matchAll(/[A-Za-z0-9_/-]+\.(?:js|ts|mjs|cjs)\b/g)].map((match) => match[0]))];
}

/** Whether a changed file is one the config names: the entry, a step, or a node's file, by its path's end. */
export function watched(path, named) {
  if (path === ENTRY || path.startsWith(STEPS_DIR)) return true;
  if (/\.test\.|\.testing\.|\/test\//.test(path)) return false;
  if (!NAMED_FOLDERS.some((folder) => path.startsWith(`${folder}/`))) return false;
  return named.some((name) => path === name || path.endsWith(`/${name}`));
}

/** Problems with a pull request's changes: node files changed, the config not, and no reason given. */
export function changeProblems(changed, config, body) {
  if (changed.includes(CONFIG) || changed.includes(NIGHTLY_PATH)) return [];
  const hits = changed.filter((path) => watched(path, namedFiles(config)));
  if (hits.length === 0 || UNCHANGED.test(body ?? "")) return [];
  return [`these files are nodes of ${CONFIG}, which this pull request does not change: ${hits.join(", ")}. Change the config where the graph changed (and run node scripts/tex-architecture.mjs), or add "Tex diagram: unchanged because <reason>" to the pull request's description.`];
}

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(js|ts|mjs)$/.test(entry) && !/\.test\.|\.testing\./.test(entry)) out.push(path);
  }
  return out;
}

function check(base) {
  const config = joinedTexConfig(ROOT);
  const problems = generatedProblems(ROOT);
  problems.push(...stepProblems(graphSteps(ROOT), config));
  const naming = [];
  for (const folder of MODEL_FOLDERS) for (const file of filesUnder(join(ROOT, folder))) if (MODEL_ID.test(readFileSync(file, "utf8"))) naming.push(relative(ROOT, file));
  const shelf = JSON.parse(readFileSync(join(ROOT, "packages/tex/src/texNodeShelf.json"), "utf8"));
  problems.push(...modelFileProblems(naming, config, Object.values(shelf.nodes ?? {}).flatMap((n) => n.files ?? [])));
  const agentFiles = filesUnder(join(ROOT, AGENT_FOLDER)).map((file) => ({ path: relative(join(ROOT, AGENT_FOLDER), file), source: readFileSync(file, "utf8") }));
  problems.push(...mapProblems(agentFiles));
  problems.push(...holdProblems(agentFiles.filter(({ source }) => HOLDS.test(source)).map(({ path }) => path), config, Object.values(shelf.nodes ?? {}).flatMap((n) => n.files ?? [])));
  const labFiles = filesUnder(join(ROOT, LAB_FOLDER)).map((file) => ({ path: relative(join(ROOT, LAB_FOLDER), file), source: readFileSync(file, "utf8") }));
  problems.push(...transportProblems(labFiles, config));
  if (!promptIsCurrent(ROOT)) problems.push(`${PROMPT_MODULE} is not what ${PROMPT_FOLDER}/*.md make: run node scripts/tex-prompt-module.mjs`);
  try {
    if (!trainingIsCurrent(ROOT)) problems.push(`${TRAINING_MODULE} is not what ${TRAINING_FOLDER}/*.json make: run node scripts/tex-training-module.mjs`);
  } catch (error) {
    problems.push(String(error.message));
  }
  if (base) {
    // The checkout is the pull request merged onto main as it is now: diff from that main, not the event's older base,
    // which counted every Tex file merged since as this pull request's (as check-tex-change-has-case.mjs, #3870).
    // Only in Actions: a local merge commit's first parent is the branch, not main.
    const from = process.env.GITHUB_ACTIONS === "true" ? (mergedOnto() ?? base) : base;
    const changed = execFileSync("git", ["diff", "--name-only", from, "HEAD"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    problems.push(...changeProblems(changed, config, process.env.TEX_PR_BODY));
  }
  return problems;
}

function selfTest() {
  const expect = (cond, what) => { if (!cond) throw new Error(`self-test: ${what}`); };
  const node = (id, file = "") => ({ id, file });
  const config = { nodes: [node("text", "apps/agent reply.ts"), node("a"), node("b"), node("send", "sendTheReply · sendOne.ts")], edges: [] };
  expect(codeSteps("(await steps.a(t)) ?? (await steps.b(t));\nawait steps.c(t, error)").join() === "a,b,c", "code steps not read in order");
  expect(stepProblems(["a", "b", "sendTheReply"], config).length === 0, "steps the config has refused");
  expect(stepProblems(["a", "b", "c"], config).length === 1, "a step with no node passed");
  expect(stepProblems(["b", "a"], config).length === 1, "steps out of the config's order passed");
  expect(stepProblems(["sendThe"], config).length === 1, "a step found by part of a file's name");
  expect(pageNames("see `reply.ts`", "packages/tex/worker/reply.ts"), "a named file was not found");
  expect(!pageNames("see `reply.ts`", "packages/tex/worker/autoreply.ts"), "a file was found by part of its name");
  expect(modelFileProblems(["packages/tex/worker/reply.ts", ...Object.keys(NOT_NODED_YET)], config).length === 0, "a node's file or a listed one refused");
  expect(modelFileProblems(["packages/tex/worker/judge.ts", ...Object.keys(NOT_NODED_YET)], config).length === 1, "a model call with no node passed");
  expect(modelFileProblems(["packages/tex/gateway/agent/graph/nodes/fresh.js", ...Object.keys(NOT_NODED_YET)], config, ["packages/tex/gateway/agent/graph/nodes/fresh.js"]).length === 0, "a shelf node's model call refused");
  expect(modelFileProblems(Object.keys(NOT_NODED_YET).slice(1), config).length === 1, "a listed file that names no model stayed listed");
  const noded = { ...config, nodes: [...config.nodes, node("x", Object.keys(NOT_NODED_YET)[0].split("/").pop())] };
  expect(modelFileProblems(Object.keys(NOT_NODED_YET), noded).length === 1, "a listed file that has its node stayed listed");
  expect(changeProblems(["packages/tex/worker/reply.ts"], config, "").length === 1, "a node's file changed without the config passed");
  expect(changeProblems(["packages/tex/gateway/agent/texEntryPoint/newStep.js"], config, "").length === 1, "a new step file changed without the config passed");
  expect(changeProblems(["packages/tex/worker/reply.ts", CONFIG], config, "").length === 0, "a change with the config refused");
  expect(changeProblems(["packages/tex/worker/reply.ts"], config, "Fixes a typo.\nTex diagram: unchanged because a log line only").length === 0, "a stated reason refused");
  expect(changeProblems(["packages/tex/worker/reply.ts"], config, "Tex diagram: unchanged because").length === 1, "an empty reason passed");
  expect(changeProblems(["packages/tex/worker/other.ts", "packages/tex/worker/reply.test.ts"], config, "").length === 0, "an unnamed file or a test refused");
  expect(MODEL_ID.test('const M = "@cf/cloudflare/clef";') && MODEL_ID.test("'anthropic/claude-haiku-5-5'") && !MODEL_ID.test("claude is nice"), "model ids misread");
  expect(mapProblems([{ path: "judge.js", source: "request({ system: SYSTEM })" }]).length === 1, "a prompt without the map passed");
  expect(mapProblems([{ path: "judge.js", source: "request({ system: withArchitecture(SYSTEM, \"x\") })" }]).length === 0, "a prompt with the map refused");
  expect(mapProblems([{ path: "aiGateway.js", source: "{ system: systemText }" }]).length === 0, "the transport refused");
  const lab = (source) => [{ path: "chatRun.js", source }];
  expect(transportProblems(lab('book.line("lineIn", {}); book.begin({ node: "send" })'), config).length === 0, "the line's steps or a node refused");
  expect(transportProblems(lab('book.begin({ node: "shadowStep" })'), config).length === 1, "a sandbox step that is no node passed");
  expect(transportProblems(lab('book.line("lineSideways", {})'), config).length === 1, "an unlisted line step passed");
  expect(transportProblems(lab('export const TRANSPORT_STEPS = Object.freeze(["lineIn"]);'), config).length === 1, "a transport list out of step passed");
  expect(transportProblems([], { ...config, nodes: [...config.nodes, node("lineIn")] }).length === 1, "transport that became a node passed");
  const holder = (id, file) => ({ id, file });
  const holds = { nodes: [holder("answerCheck", "replyJudge.js")], edges: [] };
  expect(HOLDS.test("export const CHECK_IN_SPEAK_NOTICE = \"x\";") && HOLDS.test("export async function quietGate(x) {") && !HOLDS.test("export const NOTICE_COUNT = 1;"), "holds misread");
  expect(holdProblems(["checkInSpeak.js"], holds, [], []).length === 1, "a new hold with no node passed (#3614)");
  expect(holdProblems(["replyJudge.js", "graph/nodes/quietCheck.js"], holds, [], []).length === 0, "a node's hold refused");
  expect(holdProblems(["fresh.js"], holds, [`${AGENT_FOLDER}/fresh.js`], []).length === 0, "a shelf node's hold refused");
  expect(holdProblems(["old.js"], holds, [], ["old.js"]).length === 0, "a listed hold refused");
  expect(holdProblems([], holds, [], ["old.js"]).length === 1, "a listed file that holds nothing stayed listed");
  expect(holdProblems(["replyJudge.js"], holds, [], ["replyJudge.js"]).length === 1, "a listed file that has its node stayed listed");
  expect(watched("packages/tex/gateway/agent/replyJudge.js", ["replyJudge.js"]), "a gateway node's file is not watched (check 5)");
  console.log("tex-diagram-check self-test: ok");
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) selfTest();
else {
  const at = args.indexOf("--base");
  const problems = check(at === -1 ? null : args[at + 1]);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`tex-diagram-check: ${problem}`);
    process.exit(1);
  }
  console.log("tex-diagram-check: the code matches Tex's config, and the diagram and map are generated from it");
}
