#!/usr/bin/env node
/**
 * THE TEX DIAGRAM IS TEX'S CONFIG (Dev2, 2026-11-05: "any change to the architecture must change the diagram";
 * 2026-11-14: the connections between nodes are config, never code, and Tex is told its own structure from it).
 *
 * `packages/shared/src/texConfig.json` is what Tex runs, and `docs/architecture/tex.md`'s drawing and table and the
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

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export { DIAGRAM };
const ENTRY = "apps/mcp/src/agent/texEntryPoint.js";
const STEPS_DIR = "apps/mcp/src/agent/texEntryPoint/";
/** Where a model may be named; each file that names one is a node's file, or on a list below. */
const MODEL_FOLDERS = ["apps/mcp/src/agent", "apps/agent/src", "apps/convex/functions/lib/jev"];
/** Where a node's file is looked for, by its path's end. */
const NAMED_FOLDERS = ["apps/mcp/src", "apps/agent/src", "apps/convex/functions/lib/jev"];
const MODEL_ID = /["'`](?:anthropic\/claude-[a-z0-9.-]+|@cf\/[a-z0-9._-]+\/[a-z0-9._-]+|gemini-[a-z0-9.-]+)["'`]/;
/** Files that name a model to carry or price calls for nodes, and are never a model call of their own. */
export const PLUMBING = Object.freeze({
  "apps/mcp/src/agent/production.js": "reads the texting setup, whose models are the config's",
  "apps/convex/functions/lib/jev/models.ts": "the control plane's table of models the meter knows",
  "apps/convex/functions/lib/jev/meter.ts": "prices each model's tokens for usage rows",
});
/**
 * Model calls that run today without a node of their own (Dev2, 2026-11-14: "every model call and code branch in or
 * around a turn must be a config node"). Each is being given its node; the list only shrinks.
 */
export const NOT_NODED_YET = Object.freeze({
  "apps/mcp/src/agent/daySummaries.js": "Day summaries, a nightly start",
  "apps/mcp/src/agent/pictureMaker.js": "Picture maker, called from Tools",
  "apps/mcp/src/agent/decide.js": "Clef's small choices on a person's computer",
});
/** Where a Tex agent's prompt is written: each file here that gives a model a system prompt puts the map ahead of it (`texArchitecture.js`). */
const AGENT_FOLDER = "apps/mcp/src/agent";
/** Files that carry a system prompt without writing one: the transport, the day told at its door (`withToday`), the turn that sends runTheModel's prompt, and a card template's field named system. */
const PROMPT_CARRIERS = new Set(["aiGateway.js", "builtin.js", "turn.js", "turnPrompt.js", "visuals/index.js", "texArchitecture.js", "localNow.js"]);
const GIVES_A_PROMPT = /\bsystem:\s*(?!\[)/;
const WITH_MAP = /\b(?:withArchitecture|architectureFor)\(/;
const UNCHANGED = /^\s*Tex diagram: unchanged because \S.{3,}/im;

/** Problems with the agents' prompts: one that gives a model a system prompt without the drawing. */
export function mapProblems(files) {
  return files.filter(({ path, source }) => !PROMPT_CARRIERS.has(path) && GIVES_A_PROMPT.test(source) && !WITH_MAP.test(source)).map(({ path }) => `${AGENT_FOLDER}/${path} gives a model a system prompt without the map: pass it through withArchitecture (texArchitecture.js) with its role`);
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
export function modelFileProblems(naming, config) {
  const files = config.nodes.map((n) => n.file ?? "").join(" · ");
  const named = (path) => pageNames(files, path);
  const problems = [];
  for (const path of naming) if (!named(path) && !(path in PLUMBING) && !(path in NOT_NODED_YET)) problems.push(`${path} names a model but is no node's file in ${CONFIG}: give its model call a node (or, if it only carries calls for nodes, add it to PLUMBING with why)`);
  for (const path of Object.keys(NOT_NODED_YET)) {
    if (named(path)) problems.push(`${path} is a node's file now: take it off NOT_NODED_YET in scripts/tex-diagram-check.mjs`);
    else if (!naming.includes(path)) problems.push(`${path} no longer names a model: take it off NOT_NODED_YET in scripts/tex-diagram-check.mjs`);
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
  if (changed.includes(CONFIG)) return [];
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
  const config = JSON.parse(readFileSync(join(ROOT, CONFIG), "utf8"));
  const problems = generatedProblems(ROOT);
  problems.push(...stepProblems(codeSteps(readFileSync(join(ROOT, ENTRY), "utf8")), config));
  const naming = [];
  for (const folder of MODEL_FOLDERS) for (const file of filesUnder(join(ROOT, folder))) if (MODEL_ID.test(readFileSync(file, "utf8"))) naming.push(relative(ROOT, file));
  problems.push(...modelFileProblems(naming, config));
  const agentFiles = filesUnder(join(ROOT, AGENT_FOLDER)).map((file) => ({ path: relative(join(ROOT, AGENT_FOLDER), file), source: readFileSync(file, "utf8") }));
  problems.push(...mapProblems(agentFiles));
  if (!promptIsCurrent(ROOT)) problems.push(`${PROMPT_MODULE} is not what ${PROMPT_FOLDER}/*.md make: run node scripts/tex-prompt-module.mjs`);
  if (base) {
    const changed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
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
  expect(pageNames("see `reply.ts`", "apps/agent/src/reply.ts"), "a named file was not found");
  expect(!pageNames("see `reply.ts`", "apps/agent/src/autoreply.ts"), "a file was found by part of its name");
  expect(modelFileProblems(["apps/agent/src/reply.ts", ...Object.keys(NOT_NODED_YET)], config).length === 0, "a node's file or a listed one refused");
  expect(modelFileProblems(["apps/agent/src/judge.ts", ...Object.keys(NOT_NODED_YET)], config).length === 1, "a model call with no node passed");
  expect(modelFileProblems(Object.keys(NOT_NODED_YET).slice(1), config).length === 1, "a listed file that names no model stayed listed");
  const noded = { ...config, nodes: [...config.nodes, node("x", Object.keys(NOT_NODED_YET)[0].split("/").pop())] };
  expect(modelFileProblems(Object.keys(NOT_NODED_YET), noded).length === 1, "a listed file that has its node stayed listed");
  expect(changeProblems(["apps/agent/src/reply.ts"], config, "").length === 1, "a node's file changed without the config passed");
  expect(changeProblems(["apps/mcp/src/agent/texEntryPoint/newStep.js"], config, "").length === 1, "a new step file changed without the config passed");
  expect(changeProblems(["apps/agent/src/reply.ts", CONFIG], config, "").length === 0, "a change with the config refused");
  expect(changeProblems(["apps/agent/src/reply.ts"], config, "Fixes a typo.\nTex diagram: unchanged because a log line only").length === 0, "a stated reason refused");
  expect(changeProblems(["apps/agent/src/reply.ts"], config, "Tex diagram: unchanged because").length === 1, "an empty reason passed");
  expect(changeProblems(["apps/agent/src/other.ts", "apps/agent/src/reply.test.ts"], config, "").length === 0, "an unnamed file or a test refused");
  expect(MODEL_ID.test('const M = "@cf/cloudflare/clef";') && MODEL_ID.test("'anthropic/claude-haiku-5-5'") && !MODEL_ID.test("claude is nice"), "model ids misread");
  expect(mapProblems([{ path: "judge.js", source: "request({ system: SYSTEM })" }]).length === 1, "a prompt without the map passed");
  expect(mapProblems([{ path: "judge.js", source: "request({ system: withArchitecture(SYSTEM, \"x\") })" }]).length === 0, "a prompt with the map refused");
  expect(mapProblems([{ path: "aiGateway.js", source: "{ system: systemText }" }]).length === 0, "the transport refused");
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
