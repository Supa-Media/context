#!/usr/bin/env node
/**
 * THE LAB'S EVALS FROM A COMMAND LINE (`docs/decisions/testing/lab-evals.md`). One public benchmark over a slice of its
 * questions, each in its own throwaway world (`memoryRun.mjs`), the rows and scores written as JSON:
 *
 *   node apps/mcp/bench/evals/cli.mjs longmemeval --data longmemeval_s_cleaned.json --n 50 --out result.json \
 *     [--parallel 4] [--filings 4] [--reader claude-haiku-5-5] [--judge claude-sonnet-5-5] [--fake]
 *
 * `--data` is the dataset file as Hugging Face serves it (one JSON array), or `--fetch <dir>` downloads it there first. The slice is `sliceOf`'s: the same n is the
 * same questions every time. One process answers one question at a time, because a world sets the process's clock;
 * `--parallel k` runs k child processes over k shards of the slice. Claude is reached through the AI gateway
 * (`claudeTransport`), or through the model socket when `BENCH_MODEL_SOCKET` is set (the Lab's Claude Code runs).
 * Public data only: a row holds the dataset's own question, answer and the reader's reply, never anyone's notes.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cachedEmbeddings, claudeTransport, fakeAi, fakeGateway, workersAi } from "../models.mjs";
import { modelSocket, socketSend } from "../modelSocket.mjs";
import { BENCHES, entryOf, sliceOf } from "./longMemEval.mjs";
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

const HF = "https://huggingface.co";

/**
 * The bench's dataset file in `dir`, downloaded from Hugging Face when it is not there yet: the file is found in the
 * dataset's own listing by the bench's pattern (`BENCHES`), so a renamed file is found or the run says so.
 */
export async function fetchData(bench, dir, fetchImpl = fetch) {
  const listed = await fetchImpl(`${HF}/api/datasets/${bench.repo}/tree/main`);
  if (!listed.ok) throw new Error(`Hugging Face listing for ${bench.repo}: ${listed.status}`);
  const files = (await listed.json()).filter((f) => f?.type === "file" && typeof f.path === "string" && /\.json$/i.test(f.path) && bench.file.test(f.path));
  if (files.length !== 1) throw new Error(`${bench.repo} has ${files.length} files like ${bench.file}: ${files.map((f) => f.path).join(", ")}`);
  const name = files[0].path.replace(/^.*\//, "");
  const path = join(dir, name);
  const size = files[0].lfs?.size ?? files[0].size ?? null;
  if (existsSync(path) && (!size || statSync(path).size === size)) return path;
  mkdirSync(dir, { recursive: true });
  const got = await fetchImpl(`${HF}/datasets/${bench.repo}/resolve/main/${encodeURI(files[0].path)}`);
  if (!got.ok || !got.body) throw new Error(`Hugging Face download of ${name}: ${got.status}`);
  await pipeline(Readable.fromWeb(got.body), createWriteStream(`${path}.part`));
  renameSync(`${path}.part`, path);
  say(`downloaded ${name} (${Math.round(statSync(path).size / 1e6)} MB)`);
  return path;
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
};

const MODEL = /^claude-(haiku|sonnet|opus)-[0-9-]{1,12}$/;
const say = (line) => process.stderr.write(`${line}\n`);
const usdOfRow = (row) => row.usd.filing + row.usd.reading + row.usd.judging;

/** One process's share: the items file it was handed, answered in order. */
async function answerShard(options) {
  const items = JSON.parse(readFileSync(options.items, "utf8"));
  const models = modelsFor(options);
  const run = { filings: Number(options.filings ?? DEFAULTS.filings), reader: options.reader ?? DEFAULTS.reader, judge: options.judge ?? DEFAULTS.judge };
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
  if (command !== "longmemeval") throw new Error("usage: cli.mjs longmemeval --data <file> --n <count> --out <file>");
  const { values: options } = parseArgs({ args: rest, options: OPTIONS, strict: true });
  if (!options.out) throw new Error("--out is required");
  if (options.items) return answerShard(options);
  for (const key of ["reader", "judge"]) if (options[key] && !MODEL.test(options[key])) throw new Error(`--${key} is a Claude model id`);
  const bench = BENCHES.find((b) => b.id === (options.bench ?? "longmemeval-s"));
  if (!bench) throw new Error(`no bench ${options.bench}`);
  const file = options.data ?? (options.fetch ? await fetchData(bench, options.fetch) : null);
  if (!file) throw new Error("--data <file> or --fetch <dir> is required");
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(data)) throw new Error("the dataset file is not a JSON array");
  const byId = new Map(data.map((item) => [item?.question_id, item]));
  const index = data.map((item, i) => entryOf(item, i)).filter(Boolean);
  const n = options.n === undefined ? index.length : Number(options.n);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("--n is a whole number of questions");
  const slice = sliceOf(index, n).map((entry) => byId.get(entry.id));
  const k = Math.max(1, Math.min(Number(options.parallel ?? 1) || 1, 16, slice.length));
  say(`${bench.title} ${bench.variant}: ${slice.length} of ${index.length} questions, ${k} at once`);
  const dir = mkdtempSync(join(tmpdir(), "lab-eval-"));
  const filings = Number(options.filings ?? DEFAULTS.filings);
  const pass = ["--filings", String(filings), ...(options.reader ? ["--reader", options.reader] : []), ...(options.judge ? ["--judge", options.judge] : []), ...(options.fake ? ["--fake"] : [])];
  const shards = Array.from({ length: k }, (_, s) => slice.filter((_, q) => q % k === s));
  const started = Date.now();
  await Promise.all(
    shards.map((items, s) => {
      writeFileSync(join(dir, `items-${s}.json`), JSON.stringify(items));
      return child(["--items", join(dir, `items-${s}.json`), "--out", join(dir, `rows-${s}.json`), "--shard", `${s + 1}/${k}`, ...pass]);
    }),
  );
  const order = new Map(slice.map((item, q) => [item.question_id, q]));
  const rows = shards.flatMap((_, s) => JSON.parse(readFileSync(join(dir, `rows-${s}.json`), "utf8"))).sort((a, b) => order.get(a.id) - order.get(b.id));
  const scores = scoresOf(rows);
  const perQuestion = rows.length ? scores.usd.total / rows.length : 0;
  const result = {
    bench: bench.id,
    variant: bench.variant,
    total: index.length,
    n: rows.length,
    reader: options.reader ?? DEFAULTS.reader,
    judge: options.judge ?? DEFAULTS.judge,
    filings,
    ms: Date.now() - started,
    scores,
    fullRunUsd: Math.round(perQuestion * index.length * 100) / 100,
    rows,
  };
  writeFileSync(options.out, JSON.stringify(result));
  say(`score ${scores.correct}/${scores.n} (${scores.pct ?? "-"}%), $${scores.usd.total.toFixed(2)}; all ${index.length} questions about $${result.fullRunUsd}`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    say(error?.stack ?? String(error));
    process.exit(1);
  });
}
