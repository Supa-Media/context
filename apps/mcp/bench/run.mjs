#!/usr/bin/env node
/**
 * `pnpm ai run <job>`: every setup for a job answers every question in its
 * test, as the invented person the question names, in a throwaway world, and
 * the answers land in one result note to be judged later.
 *
 *   --dir <path>        the benchmarks folder (default: $AI_BENCH_DIR, else bench/ai/ here)
 *   --test <name>       the test file (default: the job's core set, else the job's own)
 *   --setups a,b        setup file names in setups/<job>/ (default: all)
 *   --questions 1,4     only these questions
 *   --runs <n>          runs per question (default: the test's `runs`)
 *   --out <file>        where the result goes (default: results/<date> <test>.md)
 *   --fake              a scripted model: checks the plumbing, spends nothing
 *   --no-fluff          leave out the fluff files' generated notes (a quick check)
 *   --cold              skip warming: no search index, every search a bucket scan
 *   --verbose           keep the gateway's own log lines
 *
 * Runs one conversation at a time: each world swaps the global fetch, so two at
 * once would cross their wires.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, join, resolve } from "node:path";

import { PRODUCTION_HOUSEKEEPING_PATH, parseSetup } from "../src/agent/production.js";
import { expandWorkspaces, readBenchFolder, runnableQuestions } from "./load.mjs";
import { anthropicGateway, cachedEmbeddings, claudeTransport, fakeAi, fakeGateway, playPerson, workersAi } from "./models.mjs";
import { prepareRun } from "./warm.mjs";
import { judgeCommand } from "./judge.mjs";
import { scoreCommand } from "./score.mjs";
import { summaryCommand } from "./summary.mjs";
import { calibrateCommand } from "./calibrate.mjs";
import { searchCommand } from "./search.mjs";
import { checkCommand } from "./check.mjs";
import { connectCommand, publishCommand, publishSetup, pullCommand, signIn, signInCommand } from "./context.mjs";
import { improveCommand } from "./improve.mjs";
import { promoteCommand } from "./promote.mjs";
import { spendCommand } from "./spend.mjs";
import { keyMarkdown, keyPathFor, resultMarkdown } from "./report.mjs";
import { createWorld } from "./world.mjs";
import { filedNotes } from "./checks.mjs";
import { realNow } from "./clock.mjs";
import { benchFolder } from "./folder.mjs";

/**
 * The fewest texts the played person may send in one conversation. A brief
 * with more "if asked" lines gets room for each of them plus the opening text
 * and one more: golden task 7 (buy a domain) takes five, and at four the round
 * of 2026-10-17 cut it off before Tex was told it could add the DNS records.
 */
const MAX_PERSON_TEXTS = 4;

/** How many texts the played person may send for this question. */
export const personTextLimit = (question) => Math.max(MAX_PERSON_TEXTS, (question.ifAsked?.length ?? 0) + 2);

function parseArgs(argv) {
  // `pnpm ai search --fake` names no job: a first word that is a flag is one.
  const [command, ...all] = argv;
  const job = all.length > 0 && !all[0].startsWith("--") ? all.shift() : undefined;
  const rest = all;
  const options = { command, job };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--fake" || flag === "--verbose" || flag === "--no-fluff" || flag === "--cold" || flag === "--publish" || flag === "--revert") options[flag.slice(2)] = true;
    else if (flag.startsWith("--")) options[flag.slice(2)] = rest[++i];
  }
  return options;
}

const list = (value) => (value ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : null);
const version = (raw) => createHash("sha256").update(raw).digest("hex").slice(0, 12);

function commit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * The job's task skills (`src/agent/skills.js`), `setups/<job>/skills/*.md`:
 * one folder for every setup in the round, placed where production keeps
 * them, and promoted with the setup that names them. None is fine.
 */
export async function readSkills(dir, job) {
  const folder = join(dir, "setups", job, "skills");
  let names;
  try {
    names = (await readdir(folder)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const skills = [];
  for (const name of names) skills.push({ name: name.slice(0, -3), raw: await readFile(join(folder, name), "utf8") });
  return skills;
}

async function readSetups(dir, job, only) {
  const folder = join(dir, "setups", job);
  const names = (await readdir(folder)).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort();
  const chosen = only ? names.filter((name) => only.includes(name)) : names;
  if (chosen.length === 0) throw new Error(`no setups to run in setups/${job}/`);
  const setups = [];
  for (const name of chosen) {
    const raw = await readFile(join(folder, `${name}.md`), "utf8");
    const parsed = await parseSetup(raw);
    // The product would refuse it and fall back, so a run of it measures nothing.
    if (!parsed) throw new Error(`setups/${job}/${name}.md is not a valid setup file`);
    setups.push({ name, raw, version: parsed.version, model: parsed.model, router: parsed.router, fallback: parsed.fallback, skills: parsed.skills.map((skill) => skill.name) });
  }
  return setups;
}

/**
 * What the person texts back without being played: a YES when the gateway
 * held a write for their OK (the egress gate, `src/agent/route.js`), the way a
 * person who asked for the change answers. Every question gets it, a one-text
 * change included, because production asks on exactly these turns and the
 * round measures what the person gets: the extra text, its time, its words.
 */
export function personAnswers(turn, question = null) {
  // Unless the case plays the asks too (`- person answers asks`, tests/corrections.md).
  if (question?.answersAsks === true) return null;
  return turn.asked > 0 ? "YES" : null;
}

const called = (turn, name) => (turn.tools ?? []).some((call) => call.ok !== false && (call.tool === name || call.tool.startsWith(`${name} `)));
const briefLine = (question, when) => question.ifAsked.find((line) => when.test(line.when))?.say ?? null;

/**
 * What the person texts back, from the brief and without the model, when the
 * turn left them something to do: a handoff of the browser (`sites.mjs`
 * records it) is answered with the brief's "if asked to sign in, open a link,
 * or take over the browser" line, and a link to save a login (`vault_add_link`)
 * with its "sent a link to save her login" line. A played model read "text me
 * when you're done" as nothing asked and ended the conversation (round of
 * 2026-10-17), so the task never reached the page behind the sign-in. Null
 * when the turn did neither, or the brief has no line for it.
 *
 * @param {{tools?: Array<{tool: string, ok?: boolean}>}} turn
 * @param {{ifAsked: Array<{when: string, say: string}>}} question
 * @param {string[]} events the browser's record for this turn alone
 */
export function handOffAnswer(turn, question, events) {
  if (events.some((event) => event.startsWith("handoff "))) {
    const line = briefLine(question, /take over the browser|open a link|\bsign in\b/);
    if (line !== null) return line;
  }
  if (called(turn, "vault_add_link")) return briefLine(question, /sent a link to save/);
  return null;
}

/** A picture a test sends with its opening text (`- person sends picture:`), from the repository's `ai/pictures/`. */
async function benchPicture(name) {
  const data = await readFile(fileURLToPath(new URL(`./ai/pictures/${name}`, import.meta.url)));
  return { name, mediaType: /\.png$/i.test(name) ? "image/png" : "image/jpeg", data: data.toString("base64") };
}

/** One conversation: the person's opening text, then as many turns as they take. */
export async function converse(world, question, person, mode = null) {
  if (mode === "housekeeping") return await keepHouse(world, question);
  const conversation = [];
  const totals = { ms: 0, personMs: 0, tools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usageByModel: {}, rounds: {}, model: null, error: null };
  let message = question.personStarts ?? question.text;
  const limit = personTextLimit(question);
  for (let texts = 0; message !== null && texts < limit; texts += 1) {
    const pictures = texts === 0 && question.sendsPicture ? [await benchPicture(question.sendsPicture)] : [];
    conversation.push({ from: "person", text: pictures.length > 0 ? `${message}\n[Sent a picture: ${question.sendsPicture}]` : message });
    const seen = world.browser().length;
    const turn = await world.text(message, pictures);
    totals.ms += turn.ms;
    totals.tools.push(...turn.tools);
    for (const key of Object.keys(totals.usage)) totals.usage[key] += turn.usage[key];
    // What each model spent and how many rounds it ran (`src/agent/modelPlan.js`): priced model by model.
    for (const [model, spent] of Object.entries(turn.usageByModel ?? {})) {
      const into = (totals.usageByModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      for (const key of Object.keys(into)) into[key] += spent[key] ?? 0;
    }
    for (const [model, count] of Object.entries(turn.rounds ?? {})) totals.rounds[model] = (totals.rounds[model] ?? 0) + count;
    totals.model = turn.model ?? totals.model;
    if (!turn.ok) {
      totals.error = turn.error;
      break;
    }
    // Each progress line is a text the person got before the answer, as the
    // texting Worker sends them (`apps/agent/src/inbox.ts`), so it counts as one.
    for (const line of turn.progress ?? []) conversation.push({ from: "assistant", text: line });
    conversation.push({ from: "assistant", text: turn.answer });
    // Only a back-and-forth has a person who answers back. The time the played
    // person takes is the run's, not the setup's: it is kept apart from `ms`.
    const personStarted = realNow();
    message =
      personAnswers(turn, question) ??
      handOffAnswer(turn, question, world.browser().slice(seen)) ??
      (question.personStarts !== null || question.ifAsked.length > 0 ? await playPerson(person, question.body, conversation) : null);
    totals.personMs += realNow() - personStarted;
  }
  return { conversation, ...totals, texts: conversation.filter((turn) => turn.from === "assistant").length };
}

/**
 * A housekeeping test (`mode: housekeeping`): nobody texts. Tex runs once over
 * the person's own workspace, and the record says where each note a `file`
 * check names ended up (`checks.mjs`).
 */
async function keepHouse(world, question) {
  const turn = await world.keepHouse();
  const where = await world.where(filedNotes(question));
  return {
    conversation: turn.ok ? [{ from: "assistant", text: turn.answer }] : [],
    ms: turn.ms,
    personMs: 0,
    tools: turn.tools,
    usage: turn.usage,
    model: turn.model,
    error: turn.error,
    texts: turn.ok ? 1 : 0,
    where,
  };
}

/**
 * The test a job runs when none is named. The texting assistant's is its core
 * set, `tests/core.md` (decided by the owner, 2026-10-14: a short set of the
 * basics, run often; the golden tasks run by name for a round). A folder
 * without the core set runs the job's own test, as before.
 */
export const DEFAULT_TESTS = Object.freeze({ "texting-assistant": "core" });

export function testFor(options, tests) {
  if (options.test) return options.test;
  const core = DEFAULT_TESTS[options.job];
  return core && Object.hasOwn(tests, core) ? core : options.job;
}

/** A texting setup for a run that measures another job's, which texts nobody. */
const PLAIN_TEXTING_SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

/**
 * Where a run's setup goes in its world: the texting assistant's where
 * production reads it, housekeeping's at `ai/production/housekeeping.md`
 * beside a plain texting one, as `housekeeping.js` reads it.
 */
export function setupInWorld(job, setup, models) {
  if (job !== "housekeeping") return [setup.raw, models];
  const pinnedNotes = [...(models.pinnedNotes ?? []), { path: PRODUCTION_HOUSEKEEPING_PATH, raw: setup.raw }];
  return [PLAIN_TEXTING_SETUP, { ...models, pinnedNotes }];
}

/** What a run reads before it answers anything: the folder, the test, the setups, the questions. */
async function loadRun(options) {
  const dir = benchFolder(options);
  if (!options.job || !dir) throw new Error("usage: pnpm ai run <job> --dir <benchmarks folder> [--fake]");
  const loaded = await readBenchFolder(dir);
  // Fluff files are written out unless --no-fluff asks for the hand-written notes alone.
  const fluffOn = options["no-fluff"] !== true;
  const bench = fluffOn ? expandWorkspaces(loaded) : loaded;
  const fluffNotes = fluffOn ? Object.values(bench.workspaces).reduce((total, ws) => total + ws.generated.length, 0) : 0;
  const testName = testFor(options, bench.tests);
  const test = bench.tests[testName];
  if (!test) throw new Error(`no tests/${testName}.md`);
  const setups = await readSetups(dir, options.job, list(options.setups));
  const only = list(options.questions)?.map(Number);
  const questions = runnableQuestions(test.questions, only);
  const runs = Number(options.runs ?? test.front.runs);
  // Every conversation the run will have, in the order the result lists them.
  const jobs = [];
  for (const setup of setups) for (const question of questions) for (let n = 1; n <= runs; n += 1) jobs.push({ setup, question, run: n });
  const skills = await readSkills(dir, options.job);
  // A setup naming a skill the folder does not have would be measured without it.
  for (const setup of setups) {
    const missing = setup.skills.filter((name) => !skills.some((skill) => skill.name === name));
    if (missing.length) throw new Error(`setups/${options.job}/${setup.name}.md names skills with no file in setups/${options.job}/skills/: ${missing.join(", ")}`);
  }
  return { dir, bench, fluffOn, fluffNotes, testName, test, setups, questions, runs, jobs, skills };
}

/** The jobs shard `index` of `count` answers: every `count`th one, so each shard mixes setups and questions. */
export const shardJobs = (jobs, index, count) => jobs.filter((_, k) => k % count === index);

/** Answer `jobs` in this process, one conversation at a time. `label` prefixes the progress lines. */
async function answerJobs(options, { bench, test, testName = options.test ?? options.job, skills = [] }, jobs, label = "") {
  // A test that runs on the scripted web (`front.web: scripted`, `sites.mjs`)
  // searches and browses the bench's sites, never the real web.
  const scripted = test.front.web === "scripted";
  if (scripted && bench.sites.length === 0) throw new Error(`tests/${testName}.md runs on the scripted web, but sites/ has no sites`);
  const send = claudeTransport(process.env);
  if (!options.fake) process.stderr.write(`${label}Claude calls: ${send.route === "gateway" ? "through the AI gateway" : send.route === "anthropic" ? "straight to Anthropic" : "no keys set"}\n`);
  // Production's texting assistant has web search, so a run must offer it too
  // (decided 2026-10-09): without the key the assistant is measured with a
  // shorter tool list than people get. --fake runs without one.
  if (!options.fake && !scripted && options.job === "texting-assistant" && !process.env.BRAVE_SEARCH_API_KEY) {
    throw new Error("BRAVE_SEARCH_API_KEY is not set: production offers search_web and open_page, so a texting-assistant run must too (task 15 says where the key is)");
  }
  const models = options.fake
    ? { gatewayFetch: fakeGateway(), ai: cachedEmbeddings(fakeAi()) }
    : {
        gatewayFetch: anthropicGateway(send),
        // Embeds too (`@cf/baai/bge-m3`), remembered by text so each passage
        // and each query is paid for once a run.
        ai: cachedEmbeddings(workersAi(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_AI_TOKEN, process.env.AI_GATEWAY_ID ?? null)),
        searchKey: process.env.BRAVE_SEARCH_API_KEY,
        // Production reads answers for work handed back (wrangler.toml HANDBACK_JUDGE), so a real run does too.
        handbackJudge: true,
      };
  if (scripted) {
    models.sites = bench.sites;
    delete models.searchKey;
  }
  models.skills = skills;
  const person = { fake: options.fake === true, send, model: test.front.played_by };

  // Warm by default (decided 2026-10-08): every workspace indexed once, every
  // conversation a clone of it. --cold measures the scan a fresh import gets.
  const today = test.front.today ?? null;
  const prepared = options.cold ? null : await prepareRun(bench, { today, ai: models.ai });
  if (prepared) {
    const passages = [...prepared.embedded.values()].reduce((total, n) => total + n, 0);
    process.stderr.write(`${label}warmed ${prepared.buckets.size} workspaces, ${passages} passages in their meaning indexes\n`);
  }

  const records = [];
  try {
    for (const { setup, question, run: n } of jobs) {
      const [worldSetup, worldModels] = setupInWorld(options.job, setup, models);
      const as = question.as ?? test.front.run_as;
      // An answer the model never gave is run once more in a fresh world
      // (decided 2026-10-09): the gateway has already retried the round and
      // the setup's fallback has had its turn, so what is left is a bad
      // minute, and a result should measure the setup, not the minute. The
      // rerun is recorded, with the error it replaced, and counted.
      // The world pins `Date` while it exists, so wall time is read from the real clock.
      const wallStarted = realNow();
      let world = await createWorld(bench, as, worldSetup, worldModels, today, prepared);
      try {
        let result = await converse(world, question, person, test.front.mode ?? null);
        let reran = null;
        if (result.error && !options.fake) {
          reran = result.error;
          world.close();
          world = await createWorld(bench, as, worldSetup, worldModels, today, prepared);
          result = await converse(world, question, person, test.front.mode ?? null);
        }
        records.push({
          ...(reran === null ? {} : { reran }),
          setup: setup.name,
          question: question.n,
          questionText: question.text,
          as,
          kind: question.kind,
          gate: question.gate,
          run: n,
          ...result,
          model: result.model ?? setup.model,
          changes: world.changes(),
          // What the scripted browser did, for the checks (`checks.mjs`).
          browser: world.browser(),
          // Each Gmail search and read, so a result shows a search that missed.
          mail: world.mail(),
          // The emails it saved or sent, for the forward check (`checks.mjs`).
          emails: world.emails(),
          // Wall time for the whole conversation, worlds and the played person
          // included, so a run can say where its hours went.
          wallMs: realNow() - wallStarted,
        });
      } finally {
        world.close();
      }
      process.stderr.write(`${label}${setup.name} q${question.n} run ${n}: ${records.at(-1)?.error ?? "ok"}${records.at(-1)?.reran ? ` (reran after ${records.at(-1).reran})` : ""}\n`);
    }
  } finally {
    prepared?.close();
  }
  return records;
}

/**
 * THE RUN IS SHARDED ACROSS PROCESSES (decided by the owner, 2026-10-09: "the
 * last couple of rounds have taken hours, like seven hours; things could be run
 * in parallel"). A world patches the process's `fetch` and `Date`, so two
 * conversations cannot share a process; they can share a machine. The parent
 * splits the conversations into shards, spawns one child per shard with the
 * same arguments, and assembles their records in the order a single process
 * would have written them, so the result note reads the same either way.
 */
async function answerInShards(options, jobs, count) {
  const argv = [];
  const skip = new Set(["parallel", "out"]);
  const flags = new Set(["fake", "verbose", "no-fluff", "cold"]);
  for (const [key, value] of Object.entries(options)) {
    if (key === "command" || key === "job" || skip.has(key) || value === undefined) continue;
    if (flags.has(key)) {
      if (value === true) argv.push(`--${key}`);
    } else argv.push(`--${key}`, String(value));
  }
  const dir = await mkdtemp(join(tmpdir(), "bench-shards-"));
  try {
    const children = Array.from({ length: count }, (_, index) => {
      const records = join(dir, `shard-${index}.json`);
      const args = [fileURLToPath(import.meta.url), "shard", options.job, ...argv, "--shard", String(index), "--shards", String(count), "--records", records];
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"], env: process.env });
        let tail = "";
        child.stderr.on("data", (chunk) => {
          const text = String(chunk);
          tail = (tail + text).slice(-2000);
          for (const line of text.split("\n").filter(Boolean)) process.stderr.write(`[${index + 1}/${count}] ${line}\n`);
        });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve(records) : reject(new Error(`shard ${index + 1} of ${count} failed (exit ${code}): ${tail.trim().split("\n").at(-1) ?? ""}`))));
      });
    });
    const files = await Promise.all(children);
    const records = [];
    for (const file of files) records.push(...JSON.parse(await readFile(file, "utf8")));
    if (records.length !== jobs.length) throw new Error(`the shards answered ${records.length} conversations of ${jobs.length}`);
    return records;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One child's share of a run: answers its shard and writes the records as JSON for the parent. */
async function shard(options) {
  const loaded = await loadRun(options);
  const index = Number(options.shard);
  const count = Number(options.shards);
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count || !options.records) throw new Error("usage: shard <job> --shard i --shards n --records <file>");
  const records = await answerJobs(options, loaded, shardJobs(loaded.jobs, index, count));
  await writeFile(options.records, JSON.stringify(records));
}

/** How many processes a run uses: --parallel, else up to six, else one for --fake. */
export function parallelFor(options, jobCount) {
  if (options.parallel !== undefined) return Math.max(1, Math.min(Number(options.parallel) || 1, jobCount));
  return options.fake ? 1 : Math.max(1, Math.min(6, jobCount));
}

async function run(options) {
  const loaded = await loadRun(options);
  const { dir, fluffOn, fluffNotes, testName, test, setups, jobs } = loaded;
  const parallel = parallelFor(options, jobs.length);
  if (parallel > 1) process.stderr.write(`${jobs.length} conversations in ${parallel} shards\n`);
  const unordered = parallel > 1 ? await answerInShards(options, jobs, parallel) : await answerJobs(options, loaded, jobs);
  // The order a single process writes: setup, then question, then run.
  const order = new Map(setups.map((setup, i) => [setup.name, i]));
  const records = [...unordered].sort((a, b) => order.get(a.setup) - order.get(b.setup) || a.question - b.question || a.run - b.run);
  const prepared = options.cold ? null : true;

  const date = new Date().toISOString().slice(0, 10);
  const out = options.out ?? join(dir, "results", `${date} ${testName}${options.fake ? " (fake)" : ""}.md`);
  const keyOut = keyPathFor(out);
  const result = {
    job: options.job,
    test: testName,
    testVersion: version(test.raw),
    fluff: { on: fluffOn, notes: fluffNotes },
    date,
    today: test.front.today,
    world: prepared ? "warm" : "cold",
    commit: commit(),
    playedBy: options.fake ? null : test.front.played_by ?? null,
    setups: setups.map(({ name, version: v, model, router, fallback }) => ({ name, version: v, model, ...(router ? { router } : {}), ...(fallback ? { fallback } : {}) })),
    runs: records,
    resultFile: basename(out),
    keyFile: basename(keyOut),
  };
  await mkdir(join(out, ".."), { recursive: true });
  await writeFile(out, resultMarkdown(result));
  await writeFile(keyOut, keyMarkdown(result));
  process.stderr.write(`wrote ${out}\nwrote ${keyOut}\n`);
}

const USAGE = [
  "usage: pnpm ai run <job> --dir <benchmarks folder> [--fake] [--parallel <n>]",
  "       pnpm ai judge <result file> --dir <benchmarks folder> [--judge <model>] [--max-usd <n>] [--concurrency <n>] [--fake]",
  "       pnpm ai score <result file> --dir <benchmarks folder>",
  "       pnpm ai summary <result file>",
  "       pnpm ai calibrate <judged result file> [--decision <model>] [--sample <n>] [--fake]",
  "       pnpm ai search [--dir <benchmarks folder>] [--setups a,b] [--questions 1,2] [--out <note>] [--fake]",
  "       pnpm ai check <dream|heartbeat|meeting-summaries|meeting-transcription|connected-ais> [--dir <folder>] [--setups a,b] [--questions 1,2] [--out <note>] [--fake]",
  "       pnpm ai connect [--endpoint <url>]           once, by a person: the runner's grant on Context",
  "       pnpm ai signin [--show refresh-token]        the runner's sign-in, from BENCH_RUNNER_* in the environment",
  "       pnpm ai pull <job> [--dir <benchmarks folder>]   the job's setups from Context into setups/<job>/",
  "       pnpm ai publish <result file> [--run-url <url>]  the result's scores note into Context",
  "       pnpm ai improve <result file> [--setup production] [--model <model>] [--max-usd 1] [--publish] [--fake]",
  "                                                    draft one experiment from a scored round's failures",
  "       pnpm ai promote <job> --setup <name> --results <a.md,b.md> [--run-url <url>] | --revert",
  "       pnpm ai spend check <test> --setups <a,b> | spend record <result file> --run <n> [--run-url <url>]",
].join("\n");

const COMMANDS = new Map([
  ["run", run],
  ["shard", shard],
  ["judge", judgeCommand],
  ["score", scoreCommand],
  ["summary", summaryCommand],
  ["calibrate", calibrateCommand],
  ["search", searchCommand],
  ["check", checkCommand],
  ["connect", connectCommand],
  ["signin", signInCommand],
  ["pull", (options) => pullCommand(options, benchFolder(options))],
  ["publish", publishCommand],
  ["promote", promoteCommand],
  ["spend", (options) => spendCommand(options)],
  ["improve", async (options) => improveCommand(options, { publish: async (draft) => publishSetup({ ...draft, connection: await signIn({ env: process.env }) }) })],
]);

// The command line runs only when this file is the entry point; a test may
// import `shardJobs` and `parallelFor` without starting a run.
const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  // The gateway logs a line per search and turn; a run's output is the result note.
  if (!options.verbose) console.log = () => {};
  const command = COMMANDS.get(options.command);
  if (!command) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  command(options).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
