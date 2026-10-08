#!/usr/bin/env node
/**
 * `pnpm ai run <job>`: every setup for a job answers every question in its
 * test, as the invented person the question names, in a throwaway world, and
 * the answers land in one result note to be judged later.
 *
 *   --dir <path>        the benchmarks folder (default: $AI_BENCH_DIR)
 *   --test <name>       the test file (default: the job's)
 *   --setups a,b        setup file names in setups/<job>/ (default: all)
 *   --questions 1,4     only these questions
 *   --runs <n>          runs per question (default: the test's `runs`)
 *   --out <file>        where the result goes (default: results/<date> <test>.md)
 *   --fake              a scripted model: checks the plumbing, spends nothing
 *   --verbose           keep the gateway's own log lines
 *
 * Runs one conversation at a time: each world swaps the global fetch, so two at
 * once would cross their wires.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseSetup } from "../src/agent/production.js";
import { readBenchFolder } from "./load.mjs";
import { anthropicGateway, fakeAi, fakeGateway, playPerson, workersAi } from "./models.mjs";
import { resultMarkdown } from "./report.mjs";
import { createWorld } from "./world.mjs";

/** The most texts the played person may send in one conversation. */
const MAX_PERSON_TEXTS = 4;

function parseArgs(argv) {
  const [command, job, ...rest] = argv;
  const options = { command, job };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--fake" || flag === "--verbose") options[flag.slice(2)] = true;
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
    setups.push({ name, raw, version: parsed.version, model: parsed.model });
  }
  return setups;
}

/** One conversation: the person's opening text, then as many turns as they take. */
async function converse(world, question, person) {
  const conversation = [];
  const totals = { ms: 0, tools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, model: null, error: null };
  let message = question.personStarts ?? question.text;
  for (let texts = 0; message !== null && texts < MAX_PERSON_TEXTS; texts += 1) {
    conversation.push({ from: "person", text: message });
    const turn = await world.text(message);
    totals.ms += turn.ms;
    totals.tools.push(...turn.tools);
    for (const key of Object.keys(totals.usage)) totals.usage[key] += turn.usage[key];
    totals.model = turn.model ?? totals.model;
    if (!turn.ok) {
      totals.error = turn.error;
      break;
    }
    conversation.push({ from: "assistant", text: turn.answer });
    // Only a back-and-forth has a person who answers back.
    message = question.personStarts !== null || question.ifAsked.length > 0 ? await playPerson(person, question.body, conversation) : null;
  }
  return { conversation, ...totals, texts: conversation.filter((turn) => turn.from === "assistant").length };
}

async function run(options) {
  const dir = options.dir ?? process.env.AI_BENCH_DIR;
  if (!options.job || !dir) throw new Error("usage: pnpm ai run <job> --dir <benchmarks folder> [--fake]");
  const bench = await readBenchFolder(dir);
  const testName = options.test ?? options.job;
  const test = bench.tests[testName];
  if (!test) throw new Error(`no tests/${testName}.md`);
  const setups = await readSetups(dir, options.job, list(options.setups));
  const only = list(options.questions)?.map(Number);
  const questions = test.questions.filter((question) => !only || only.includes(question.n));
  const runs = Number(options.runs ?? test.front.runs);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const models = options.fake
    ? { gatewayFetch: fakeGateway(), ai: fakeAi() }
    : { gatewayFetch: anthropicGateway(apiKey), ai: workersAi(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_AI_TOKEN) };
  const person = { fake: options.fake === true, apiKey, model: test.front.played_by };

  const records = [];
  for (const setup of setups) {
    for (const question of questions) {
      const as = question.as ?? test.front.run_as;
      for (let n = 1; n <= runs; n += 1) {
        const world = await createWorld(bench, as, setup.raw, models);
        try {
          const result = await converse(world, question, person);
          records.push({
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
          });
        } finally {
          world.close();
        }
        process.stderr.write(`${setup.name} q${question.n} run ${n}: ${records.at(-1)?.error ?? "ok"}\n`);
      }
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const markdown = resultMarkdown({
    job: options.job,
    test: testName,
    testVersion: version(test.raw),
    date,
    commit: commit(),
    playedBy: options.fake ? null : test.front.played_by ?? null,
    setups: setups.map(({ name, version: v, model }) => ({ name, version: v, model })),
    runs: records,
  });
  const out = options.out ?? join(dir, "results", `${date} ${testName}${options.fake ? " (fake)" : ""}.md`);
  await mkdir(join(out, ".."), { recursive: true });
  await writeFile(out, markdown);
  process.stderr.write(`wrote ${out}\n`);
}

const options = parseArgs(process.argv.slice(2));
// The gateway logs a line per search and turn; a run's output is the result note.
if (!options.verbose) console.log = () => {};
if (options.command !== "run") {
  process.stderr.write("usage: pnpm ai run <job> --dir <benchmarks folder> [--fake]\n");
  process.exit(2);
}
run(options).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
