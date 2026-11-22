#!/usr/bin/env node
/**
 * THE LAB'S EVALS FROM A COMMAND LINE (`docs/decisions/testing/lab-evals.md`). One benchmark (a folder of
 * `packages/bench/benchmarks/`) over a slice of its questions, each in its own throwaway world (`memoryRun.mjs`), the
 * rows and scores written as JSON:
 *
 *   node apps/mcp/bench/evals/cli.mjs longmemeval [--bench longmemeval-s] --data longmemeval_s_cleaned.json --n 50 \
 *     --out result.json [--parallel 4] [--filings 4] [--reader claude-haiku-5-5] [--judge claude-sonnet-5-5] [--fake]
 *   node apps/mcp/bench/evals/cli.mjs search --bench <run id> ...   (searchCli.mjs)
 *
 * A memory run takes any benchmark's BEIR set: its source reads `--data` (the dataset file) or downloads into
 * `--fetch <dir>`, and slices it (LongMemEval's slice is the same n questions every time). One process answers one question at a time, because a world sets the process's clock;
 * `--parallel k` runs k child processes over k shards of the slice. Claude is reached through the AI gateway
 * (`claudeTransport`), or through the model socket when `BENCH_MODEL_SOCKET` is set (the Lab's Claude Code runs).
 * Public data only: a row holds the dataset's own question, answer and the reader's reply, never anyone's notes.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cachedEmbeddings, claudeTransport, fakeAi, fakeGateway, workersAi } from "../models.mjs";
import { modelSocket, socketSend } from "../modelSocket.mjs";
import { memoryCases } from "../../../../packages/bench/src/beir.mjs";
import { benchmarkOf } from "../../../../packages/bench/src/registry.mjs";
import { DEFAULTS, runQuestion, scoresOf } from "./memoryRun.mjs";

const HERE = fileURLToPath(import.meta.url);

/** A scripted Claude for `--fake`: the bench's fake for the reader and filing, and a judge that says yes when the reply holds the answer's longest word. */
export function fakeSend() {
  const gateway = fakeGateway();
  return async (body) => {
    const parsed = JSON.parse(body);
    const prompt = typeof parsed.messages?.[0]?.content === "string" ? parsed.messages[0].content : "";
    if (!parsed.tools && /Answer yes or no only\.$/.test(prompt)) {
      const expected = /\n\n(?:Correct Answer|Rubric|Explanation): ([^\n]*)/.exec(prompt)?.[1] ?? "";
      const reply = /\n\nModel Response: ([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? "";
      const word = expected.split(/\W+/).sort((a, b) => b.length - a.length)[0]?.toLowerCase() ?? "";
      const yes = word !== "" && reply.toLowerCase().includes(word);
      return new Response(JSON.stringify({ content: [{ type: "text", text: yes ? "yes" : "no" }], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 1 } }), { status: 200 });
    }
    return gateway("fake", { body });
  };
}

/** How this process reaches its models: scripted, the model socket, or the AI gateway. */
export function modelsFor(options, env = process.env) {
  if (options.fake) return { send: fakeSend(), ai: cachedEmbeddings(fakeAi()), route: "fake", socket: null };
  const socket = modelSocket(env);
  const send = socket?.covers("claude") ? socketSend(socket) : claudeTransport(env);
  const ai =
    env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_TOKEN
      ? cachedEmbeddings(workersAi(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_AI_TOKEN, env.AI_GATEWAY_ID ?? null))
      : cachedEmbeddings(fakeAi());
  return { send, ai, route: send.route ?? null, socket };
}

const OPTIONS = {
  data: { type: "string" },
  fetch: { type: "string" },
  n: { type: "string" },
  out: { type: "string" },
  parallel: { type: "string" },
  filings: { type: "string" },
  reader: { type: "string" },
  judge: { type: "string" },
  bench: { type: "string" },
  fake: { type: "boolean" },
  shard: { type: "string" },
  items: { type: "string" },
  part: { type: "string" },
  sets: { type: "string" },
  cases: { type: "string" },
  today: { type: "string" },
  "keep-records": { type: "boolean" },
  // Search the bucket world only, without the workspace-object world beside it (`objectWorld.mjs`).
  "database-only": { type: "boolean" },
  "world-cache": { type: "string" },
  "warm-only": { type: "boolean" },
};

const MODEL = /^claude-(haiku|sonnet|opus)-[0-9-]{1,12}$/;
const say = (line) => process.stderr.write(`${line}\n`);
const usdOfRow = (row) => row.usd.filing + row.usd.reading + row.usd.judging;

/** One process's share: the items file it was handed, answered in order. */
async function answerShard(options) {
  const items = JSON.parse(readFileSync(options.items, "utf8"));
  const models = modelsFor(options);
  const { run: bench, source } = await benchmarkOf(options.bench ?? "longmemeval-s");
  const run = { filings: Number(options.filings ?? DEFAULTS.filings), reader: options.reader ?? DEFAULTS.reader, judge: options.judge ?? DEFAULTS.judge, platform: bench.benchmark, ...(source.judgePrompt ? { judgePrompt: source.judgePrompt } : {}) };
  const rows = [];
  // A world's gateway logs a JSON line per step; a shard prints one line per question instead.
  const log = console.log;
  console.log = () => {};
  try {
    for (const item of items) {
      const row = await runQuestion(item, models, run);
      rows.push(row);
      const verdict = row.correct === true ? "right" : row.correct === false ? "wrong" : "not graded";
      say(`${options.shard ?? "1/1"} ${row.id} ${verdict} (${row.sessions} sessions, ${row.filings} filings, $${usdOfRow(row).toFixed(4)}, ${Math.round(row.ms / 1000)} s)${row.error ? `: ${row.error.split("\n")[0]}` : ""}`);
    }
  } finally {
    console.log = log;
  }
  writeFileSync(options.out, JSON.stringify(rows));
}

/**
 * A search run in k processes: the data fetched once here, then k children (`--shard s/k`), each writing its records,
 * put back in the order one process would have asked them and scored as one run.
 */
async function searchInParallel(options, argv) {
  const { resultOf } = await import("./searchCli.mjs");
  const k = Math.max(1, Math.min(Number(options.parallel) || 1, 16));
  const started = Date.now();
  // Fetched and cut once, before any child reads it: k children downloading the same corpus at once would race.
  const { run, source } = await benchmarkOf(options.bench ?? "search-hard");
  if (run.format === "beir" && (options.fetch || options.data)) await source.load({ run, dir: options.fetch ?? null, data: options.data ?? null, sets: options.sets ? String(options.sets).split(",") : null, n: null });
  const dir = mkdtempSync(join(tmpdir(), "search-shards-"));
  // The worlds built once here and kept, so each child loads them rather than building its own: in the run's world
  // cache when it has one (`worldCache.mjs`), else in a folder of this run's.
  const cache = options["world-cache"] ?? process.env.BENCH_WORLD_CACHE ?? join(dir, "worlds");
  const { runSearchSet } = await import("./searchCli.mjs");
  await runSearchSet({ ...options, "world-cache": cache, "warm-only": true });
  const without = (args, names) => args.filter((arg, i) => !names.includes(arg) && !names.includes(args[i - 1]));
  const base = [...without(argv, ["--parallel", "--out", "--keep-records", "--world-cache"]), "--world-cache", cache];
  await Promise.all(
    Array.from({ length: k }, (_, s) =>
      new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [...process.execArgv, HERE, "search", ...base, "--shard", `${s + 1}/${k}`, "--out", join(dir, `shard-${s}.json`)], { stdio: ["ignore", "inherit", "inherit"] });
        proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`search shard ${s + 1}/${k} exited ${code}`))));
        proc.on("error", reject);
      }),
    ),
  );
  const parts = Array.from({ length: k }, (_, s) => JSON.parse(readFileSync(join(dir, `shard-${s}.json`), "utf8")));
  // Dealt back round-robin: shard s held cases s, s + k, s + 2k, ..., so this is one process's order.
  const records = [];
  for (let i = 0; parts.some((p) => i < (p.records ?? []).length); i += 1) for (const p of parts) if (i < (p.records ?? []).length) records.push(p.records[i]);
  rmSync(dir, { recursive: true, force: true });
  return resultOf(run, { total: parts[0]?.total ?? null, records, ms: Date.now() - started, keep: options["keep-records"] === true });
}

function child(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [HERE, "longmemeval", ...args], { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`shard exited ${code}`))));
    proc.on("error", reject);
  });
}

/** The whole run: read the dataset, slice it, answer the shards, and write the result. */
export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command !== "longmemeval" && command !== "search") throw new Error("usage: cli.mjs longmemeval --data <file> --n <count> --out <file> | cli.mjs search --bench <set> --out <file>");
  const { values: options } = parseArgs({ args: rest, options: OPTIONS, strict: true });
  if (!options.out) throw new Error("--out is required");
  if (command === "search") {
    // The Search suite (`searchCli.mjs`): embeddings only, no Claude. `--parallel k` searches in k processes, each
    // building the same world and asking every k-th question: a search is CPU in this process, so one process asks
    // one at a time however many it is handed (2026-11-22: 343 questions over 10,000 notes, two seconds each).
    const { runSearchSet } = await import("./searchCli.mjs");
    const result = Number(options.parallel ?? 1) > 1 && !options.shard ? await searchInParallel(options, rest) : await runSearchSet(options);
    writeFileSync(options.out, JSON.stringify(result));
    const s = result.search;
    say(`${result.bench}: right note first ${s.first}/${s.n} (${s.firstPct ?? "-"}%), top 5 ${s.top5Pct ?? "-"}%, MRR ${s.mrr}, p50 ${s.p50Ms} ms${s.recallAny5Pct !== undefined ? `, recall@5 any ${s.recallAny5Pct}% all ${s.recallAll5Pct}%` : ""}${s.byPath ? `; answered by ${Object.entries(s.byPath).map(([p, n]) => `${p} ${n}`).join(", ")}` : ""}`);
    if (s.ndcg10 !== undefined) say(`  nDCG@10 ${s.ndcg10} (BM25 ${s.bm25Ndcg10 ?? "none"}${s.objectNdcg10 !== undefined ? `, objects ${s.objectNdcg10}` : ""}), Recall@10 ${s.recall10}, MRR@10 ${s.mrr10}; ${Object.entries(s.bySet).map(([k, v]) => `${k} ${v.ndcg10}`).join(", ")}`);
    if (s.objects) say(`  in workspace objects: right note first ${s.objects.first}/${s.objects.n} (${s.objects.firstPct ?? "-"}%), top 5 ${s.objects.top5Pct ?? "-"}%, MRR ${s.objects.mrr}, p50 ${s.objects.p50Ms} ms; same rank ${s.objects.same}, better ${s.objects.better}, worse ${s.objects.worse}`);
    if (result.n > 0 && s.n === 0) throw new Error("no case was scored");
    return result;
  }
  if (options.items) return answerShard(options);
  for (const key of ["reader", "judge"]) if (options[key] && !MODEL.test(options[key])) throw new Error(`--${key} is a Claude model id`);
  const { run: bench, source } = await benchmarkOf(options.bench ?? "longmemeval-s");
  if (bench.kind !== "memory" && bench.format !== "beir") throw new Error(`${bench.id} has no memory run: its folder is not a BEIR set`);
  const n = options.n === undefined ? null : Number(options.n);
  if (n !== null && (!Number.isSafeInteger(n) || n < 1)) throw new Error("--n is a whole number of questions");
  const [set] = await source.load({ run: { ...bench, kind: "memory" }, dir: options.fetch ?? null, data: options.data ?? null, n });
  const all = memoryCases(set);
  const slice = n === null || bench.slice === "source" ? all : all.slice(0, n);
  const total = Number.isSafeInteger(set.total) ? set.total : all.length;
  const k = Math.max(1, Math.min(Number(options.parallel ?? 1) || 1, 16, slice.length));
  say(`${bench.title} ${bench.variant}: ${slice.length} of ${total} questions, ${k} at once`);
  const dir = mkdtempSync(join(tmpdir(), "lab-eval-"));
  const filings = Number(options.filings ?? DEFAULTS.filings);
  const pass = ["--bench", bench.id, "--filings", String(filings), ...(options.reader ? ["--reader", options.reader] : []), ...(options.judge ? ["--judge", options.judge] : []), ...(options.fake ? ["--fake"] : [])];
  const shards = Array.from({ length: k }, (_, s) => slice.filter((_, q) => q % k === s));
  const started = Date.now();
  await Promise.all(
    shards.map((items, s) => {
      writeFileSync(join(dir, `items-${s}.json`), JSON.stringify(items));
      return child(["--items", join(dir, `items-${s}.json`), "--out", join(dir, `rows-${s}.json`), "--shard", `${s + 1}/${k}`, ...pass]);
    }),
  );
  const order = new Map(slice.map((c, q) => [c.id, q]));
  const rows = shards.flatMap((_, s) => JSON.parse(readFileSync(join(dir, `rows-${s}.json`), "utf8"))).sort((a, b) => order.get(a.id) - order.get(b.id));
  const scores = scoresOf(rows, source.ABILITIES ?? null);
  const perQuestion = rows.length ? scores.usd.total / rows.length : 0;
  const result = {
    bench: bench.id,
    variant: bench.variant,
    total,
    n: rows.length,
    reader: options.reader ?? DEFAULTS.reader,
    judge: options.judge ?? DEFAULTS.judge,
    filings,
    ms: Date.now() - started,
    scores,
    fullRunUsd: Math.round(perQuestion * total * 100) / 100,
    rows,
  };
  writeFileSync(options.out, JSON.stringify(result));
  // A run that graded nothing failed, whatever it wrote: the first question's reason is the run's.
  if (rows.length > 0 && scores.n === 0) throw new Error(`no question was graded: ${rows.find((row) => row.error)?.error?.split("\n")[0] ?? "no reason given"}`.slice(0, 280));
  say(`score ${scores.correct}/${scores.n} (${scores.pct ?? "-"}%), $${scores.usd.total.toFixed(2)}; all ${total} questions about $${result.fullRunUsd}`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    say(error?.stack ?? String(error));
    process.exit(1);
  });
}
