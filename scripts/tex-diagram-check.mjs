#!/usr/bin/env node
/**
 * THE TEX DIAGRAM MOVES WITH THE ARCHITECTURE (Dev2, 2026-11-05: "have a
 * standing rule that any change to the architecture must change the diagram,
 * that way I can always go to the diagram and see what changed").
 *
 * `docs/architecture/tex.md` is the one drawing of Tex. This checks it against
 * the code, so a change that leaves it behind fails CI:
 *
 *   1. Every step `texEntryPoint.js` runs is drawn in the page's steps region,
 *      in the order the code runs them.
 *   2. Every file under the scanned folders that names a model (a Claude,
 *      Cloudflare or Gemini model id) is named on the page, so a new model,
 *      judge or check cannot join unseen.
 *   3. With `--base <sha>` (a pull request): a change to `texEntryPoint.js`, a
 *      file under `texEntryPoint/`, or any file the page names must change the
 *      page too, unless the pull request's description (env `TEX_PR_BODY`) has
 *      a line `Tex diagram: unchanged because <reason>`.
 *
 * Usage:
 *   node scripts/tex-diagram-check.mjs                 checks 1 and 2
 *   node scripts/tex-diagram-check.mjs --base <sha>    also check 3, against that commit
 *   node scripts/tex-diagram-check.mjs --self-test
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULE as MAP_MODULE, moduleIsCurrent } from "./tex-architecture-module.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DIAGRAM = "docs/architecture/tex.md";
const ENTRY = "apps/mcp/src/agent/texEntryPoint.js";
const STEPS_DIR = "apps/mcp/src/agent/texEntryPoint/";
/** Where a model may be named; each file that names one is named on the page. */
const MODEL_FOLDERS = ["apps/mcp/src/agent", "apps/agent/src", "apps/convex/functions/lib/jev"];
/** Where a file the page names is looked for, by its path's end. */
const NAMED_FOLDERS = ["apps/mcp/src", "apps/agent/src", "apps/convex/functions/lib/jev"];
const MODEL_ID = /["'`](?:anthropic\/claude-[a-z0-9.-]+|@cf\/[a-z0-9._-]+\/[a-z0-9._-]+|gemini-[a-z0-9.-]+)["'`]/;
/** Where a Tex agent's prompt is written: each file here that gives a model a system prompt puts the drawing ahead of it (`texArchitecture.js`). */
const AGENT_FOLDER = "apps/mcp/src/agent";
/** Files that carry a system prompt without writing one: the transport, the day told at its door (`withToday`), the turn that sends runTheModel's prompt, and a card template's field named system. */
const PROMPT_CARRIERS = new Set(["aiGateway.js", "builtin.js", "turn.js", "turnPrompt.js", "visuals/index.js", "texArchitecture.js", "localNow.js"]);
const GIVES_A_PROMPT = /\bsystem:\s*(?!\[)/;
const WITH_MAP = /\b(?:withArchitecture|architectureFor)\(/;
const UNCHANGED = /^\s*Tex diagram: unchanged because \S.{3,}/im;

/** Problems with the agents' prompts: one that gives a model a system prompt without the drawing. */
export function mapProblems(files) {
  return files.filter(({ path, source }) => !PROMPT_CARRIERS.has(path) && GIVES_A_PROMPT.test(source) && !WITH_MAP.test(source)).map(({ path }) => `${AGENT_FOLDER}/${path} gives a model a system prompt without the drawing: pass it through withArchitecture (texArchitecture.js) with its role`);
}

/** The steps the code runs, in order: each `steps.<name>(t` in the entry file. */
export function codeSteps(source) {
  return [...source.matchAll(/\bsteps\.([a-zA-Z]+)\(t\b/g)].map((match) => match[1]);
}

/** The steps the page draws, in order: each node id defined inside the steps region. */
export function drawnSteps(page) {
  const region = page.match(/<!-- tex-diagram: steps begin -->([\s\S]*?)<!-- tex-diagram: steps end -->/);
  if (region === null) return null;
  const seen = [];
  for (const match of region[1].matchAll(/^\s*([a-zA-Z]+)\[/gm)) if (!seen.includes(match[1])) seen.push(match[1]);
  return seen;
}

/** Problems with the steps: missing, extra, or out of order. */
export function stepProblems(code, drawn) {
  if (drawn === null) return [`${DIAGRAM} has no steps region (<!-- tex-diagram: steps begin --> ... end -->)`];
  const problems = [];
  for (const name of code) if (!drawn.includes(name)) problems.push(`step ${name} runs in ${ENTRY} but is not drawn in ${DIAGRAM}`);
  for (const name of drawn) if (!code.includes(name)) problems.push(`step ${name} is drawn in ${DIAGRAM} but ${ENTRY} no longer runs it`);
  const both = code.filter((name) => drawn.includes(name));
  const order = drawn.filter((name) => code.includes(name));
  if (problems.length === 0 && both.join() !== order.join()) problems.push(`${DIAGRAM} draws the steps in another order than ${ENTRY} runs them: ${both.join(" → ")}`);
  return problems;
}

/** Whether a page names a file: its name, as a whole word, anywhere on it. */
export function pageNames(page, path) {
  const base = path.split("/").pop();
  return new RegExp(`(^|[^A-Za-z0-9_.-])${base.replace(/[.]/g, "\\.")}($|[^A-Za-z0-9_-])`).test(page);
}

/** The file names the page mentions (`name.js`, `dir/name.ts`), as written. */
export function namedFiles(page) {
  return [...new Set([...page.matchAll(/[A-Za-z0-9_/-]+\.(?:js|ts|mjs)\b/g)].map((match) => match[0]))];
}

/** Whether a changed file is one the page draws: the entry, a step, or a file it names, by its path's end. */
export function watched(path, named) {
  if (path === ENTRY || path.startsWith(STEPS_DIR)) return true;
  if (/\.test\.|\.testing\.|\/test\//.test(path)) return false;
  if (!NAMED_FOLDERS.some((folder) => path.startsWith(`${folder}/`))) return false;
  return named.some((name) => path === name || path.endsWith(`/${name}`));
}

/** Problems with a pull request's changes: page files changed, page not, and no reason given. */
export function changeProblems(changed, page, body) {
  if (changed.includes(DIAGRAM)) return [];
  const named = namedFiles(page);
  const hits = changed.filter((path) => watched(path, named));
  if (hits.length === 0 || UNCHANGED.test(body ?? "")) return [];
  return [`these files are drawn in ${DIAGRAM}, which this pull request does not change: ${hits.join(", ")}. Redraw what changed and add a change log line, or add "Tex diagram: unchanged because <reason>" to the pull request's description.`];
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
  const page = readFileSync(join(ROOT, DIAGRAM), "utf8");
  const problems = stepProblems(codeSteps(readFileSync(join(ROOT, ENTRY), "utf8")), drawnSteps(page));
  for (const folder of MODEL_FOLDERS) {
    for (const file of filesUnder(join(ROOT, folder))) {
      const path = relative(ROOT, file);
      if (MODEL_ID.test(readFileSync(file, "utf8")) && !pageNames(page, path)) problems.push(`${path} names a model but ${DIAGRAM} does not name it: draw what it does`);
    }
  }
  const agentFiles = filesUnder(join(ROOT, AGENT_FOLDER)).map((file) => ({ path: relative(join(ROOT, AGENT_FOLDER), file), source: readFileSync(file, "utf8") }));
  problems.push(...mapProblems(agentFiles));
  if (!moduleIsCurrent(ROOT)) problems.push(`${MAP_MODULE} is not what ${DIAGRAM} makes: run node scripts/tex-architecture-module.mjs`);
  if (base) {
    const changed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    problems.push(...changeProblems(changed, page, process.env.TEX_PR_BODY));
  }
  return problems;
}

function selfTest() {
  const page = "<!-- tex-diagram: steps begin -->\n  a[\"a\"]\n  b[\"b\"]\n  a --> b\n<!-- tex-diagram: steps end -->\nsee `reply.ts` and texEntryPoint.js";
  const expect = (cond, what) => { if (!cond) throw new Error(`self-test: ${what}`); };
  expect(codeSteps("(await steps.a(t)) ?? (await steps.b(t));\nawait steps.c(t, error)").join() === "a,b,c", "code steps not read in order");
  expect(stepProblems(["a", "b"], drawnSteps(page)).length === 0, "matching steps refused");
  expect(stepProblems(["a", "b", "c"], drawnSteps(page)).length === 1, "an undrawn step passed");
  expect(stepProblems(["a"], drawnSteps(page)).length === 1, "a drawn step the code dropped passed");
  expect(stepProblems(["b", "a"], drawnSteps(page)).length === 1, "steps out of order passed");
  expect(stepProblems(["a"], drawnSteps("no region")).length === 1, "a page without a steps region passed");
  expect(pageNames(page, "apps/agent/src/reply.ts"), "a named file was not found");
  expect(!pageNames(page, "apps/agent/src/autoreply.ts"), "a file was found by part of its name");
  expect(changeProblems(["apps/agent/src/reply.ts"], page, "").length === 1, "a named file changed without the page passed");
  expect(changeProblems(["apps/mcp/src/agent/texEntryPoint/newStep.js"], page, "").length === 1, "a new step file changed without the page passed");
  expect(changeProblems(["apps/agent/src/reply.ts", DIAGRAM], page, "").length === 0, "a change with the page refused");
  expect(changeProblems(["apps/agent/src/reply.ts"], page, "Fixes a typo.\nTex diagram: unchanged because a log line only").length === 0, "a stated reason refused");
  expect(changeProblems(["apps/agent/src/reply.ts"], page, "Tex diagram: unchanged because").length === 1, "an empty reason passed");
  expect(changeProblems(["apps/agent/src/other.ts", "apps/agent/src/reply.test.ts"], page, "").length === 0, "an unnamed file or a test refused");
  expect(MODEL_ID.test('const M = "@cf/cloudflare/clef";') && MODEL_ID.test("'anthropic/claude-haiku-5-5'") && !MODEL_ID.test("claude is nice"), "model ids misread");
  expect(mapProblems([{ path: "judge.js", source: "request({ system: SYSTEM })" }]).length === 1, "a prompt without the drawing passed");
  expect(mapProblems([{ path: "judge.js", source: "request({ system: withArchitecture(SYSTEM, \"x\") })" }]).length === 0, "a prompt with the drawing refused");
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
  console.log("tex-diagram-check: the diagram matches the code");
}
