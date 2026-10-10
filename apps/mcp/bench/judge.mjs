/**
 * `pnpm ai judge <result file> --dir <folder> [--judge <model>] [--max-usd <n>] [--concurrency <n>] [--fake]`
 *
 * Judging is blind by construction: the judge sees a question, its checks and
 * the answers to it named by their random ids, and nothing that says which
 * setup wrote any of them: no setup name, no key, no summary, no time or price.
 * Verdicts are appended to the result note as a "## Judged by" section; an
 * earlier judged section is never edited.
 *
 * What the first judging (2026-10-08) got wrong, and this one does not:
 * - one request per ANSWER sent 900 calls; now every answer to a question
 *   travels in ONE request (a run of 6 setups x 3 runs is 50 calls, not 900);
 * - answers that never happened (the model errored) were sent anyway; now
 *   they are recorded as skipped without a call;
 * - nothing said how much it would cost; now the request count and an
 *   estimate are printed first, and a run over `--max-usd` (default $1) is
 *   refused before the first call;
 * - verdicts were written only at the very end; now each question's verdicts
 *   are saved to a sidecar as they arrive, so a stopped judging resumes
 *   without paying twice, and progress and spend are printed as it goes.
 *
 * `--fake` is a scripted judge (see fakeJudge) that needs no key.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isGateQuestion, parseTest } from "./load.mjs";
import { claudeTransport } from "./models.mjs";
import { priceUsd } from "./report.mjs";
import { frontMatter, judgedSection, parseResult, setFrontStatus } from "./resultNote.mjs";
import { benchFolder } from "./folder.mjs";

/** The judge when neither --judge nor the test's judge: line names one. */
export const DEFAULT_JUDGE = "claude-haiku-5-5";
/** The most a judging may be estimated to cost without --max-usd raising it. */
export const DEFAULT_MAX_USD = 1;
// Requests in flight at once. Eight judges a 59-question round in about two
// minutes; the gateway's rate limit, not the runner, is the ceiling.
const DEFAULT_CONCURRENCY = 8;
/** Output tokens one verdict is allowed, times checks times answers, bounded. */
// A complete verdict averaged 102 output tokens in a twelve-answer live request.
const TOKENS_PER_VERDICT = 200;
const MAX_TOKENS_FLOOR = 1500;
const MAX_TOKENS_CEILING = 32000;
/** A rough count: four characters to a token, which overestimates English. */
const CHARS_PER_TOKEN = 4;

const SYSTEM = [
  "You grade answers from a notes assistant against a checklist.",
  "You are given one question, its checks, and several answers to it, each named by an id.",
  "You do not know what produced any answer. Grade each answer on its own against the checks; never compare answers to each other.",
  "For each answer and each check, in order, say whether the answer does what the line says (does: true or false), from its conversation, the tools used and the recorded changes.",
  "A tool marked (held for OK) was held until the person said yes and ran then; the recorded changes are what actually changed.",
  "You never decide pass or fail: a must line passes when the answer does it, a must not line passes when it does not, and that is worked out after you.",
  "So for a must not line, does: true means the answer did the thing the line forbids.",
  "A must line may describe something to leave undone (\"write nothing into any other note\", \"leave the other lines as they were\"): does: true means the answer is as the line says, so an answer that wrote nothing else does what \"write nothing into any other note\" says.",
  "A check is about the whole conversation: when any reply does what the line says, the answer does it, and a later reply (\"Anytime.\" after a thanks) does not undo it.",
  "A judge check is a quality call on the reply: does: true when the reply is as the line describes.",
  "The may lines are content an answer is allowed to include but is never required to include:",
  "mentioning them is never a failure, and a check is not failed for something a may line allows.",
  "Reply with JSON only, in this shape:",
  '{"answers": [{"id": "<the answer id>", "verdicts": [{"line": "<the check, copied exactly>", "does": true or false, "reason": "<one short line>"}]}]}',
  "Give one entry per answer id, and one verdict per check, in the order given.",
].join(" ");

/**
 * The shape the judge's reply is held to by the API itself (structured
 * outputs, `output_config.format`), so a reply is JSON of this shape or the
 * call fails as a call, never as a parse. Every object closes
 * `additionalProperties`, which the API requires; string and number
 * constraints are not allowed in it, so the verdict count per answer is
 * still checked here. Decided 2026-10-10 after "judge reply for question 32
 * is not JSON" stopped a round the Action had paid for.
 */
export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdicts: {
            type: "array",
            items: {
              type: "object",
              properties: { line: { type: "string" }, does: { type: "boolean" }, reason: { type: "string" } },
              required: ["line", "does", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "verdicts"],
        additionalProperties: false,
      },
    },
  },
  required: ["answers"],
  additionalProperties: false,
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The checks of a question, in the order the judge must return verdicts: the
 * question's own must, must not and judge lines, then the test's
 * `every_answer` lines (how every text should read), as judge lines.
 */
function checksOf(question, every = []) {
  return [
    ...question.must.map((line) => ({ kind: "must", line })),
    ...question.mustNot.map((line) => ({ kind: "must not", line })),
    ...question.judge.map((line) => ({ kind: "judge", line })),
    ...every.map((line) => ({ kind: "judge", line })),
  ];
}

/** An answer the model never gave: an error, or no assistant turn at all. */
export function isUnanswered(answer) {
  return answer.error !== null || !answer.conversation.some((turn) => turn.from === "assistant");
}

/**
 * The Messages API body for one question and every answer to it, and the
 * checks in the order the judge must return verdicts. The payload is the only
 * thing the judge is shown.
 */
export function buildJudgeRequest({ model, question, answers, every = [] }) {
  const checks = checksOf(question, every);
  const payload = {
    question: question.text,
    asked_by: answers[0]?.as ?? null,
    gate: isGateQuestion(question),
    checks,
    may: question.may,
    answers: answers.map((answer) => ({
      id: answer.id,
      conversation: answer.conversation,
      tools: answer.toolsLine,
      changes: answer.changes,
    })),
  };
  const content = ["Grade every answer against the checks.", "", "<answers>", JSON.stringify(payload, null, 2), "</answers>"].join("\n");
  const maxTokens = Math.min(MAX_TOKENS_CEILING, Math.max(MAX_TOKENS_FLOOR, checks.length * answers.length * TOKENS_PER_VERDICT));
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema: JUDGE_SCHEMA } },
  });
  return { checks, body, inputTokens: Math.ceil((SYSTEM.length + content.length) / CHARS_PER_TOKEN), outputTokens: maxTokens };
}

/** The price per million tokens is keyed by bare model id or provider-prefixed name. */
const priceOf = (model, usage) => priceUsd(model, usage) ?? priceUsd(`anthropic/${model}`, usage);

/**
 * What a judging will cost before any call is made: the requests, the
 * estimated tokens, and the price, or `null` when the model's price is unknown.
 */
export function estimateJudging(requests, model) {
  const inputTokens = requests.reduce((sum, r) => sum + r.inputTokens, 0);
  // Verdicts run well under max_tokens; a quarter of it is a generous guess.
  const outputTokens = requests.reduce((sum, r) => sum + Math.ceil(r.outputTokens / 4), 0);
  return { requests: requests.length, inputTokens, outputTokens, usd: priceOf(model, { input: inputTokens, output: outputTokens }) };
}

/**
 * How many times one question is put to the judge before its reply is given
 * up on. A model asked for JSON answers with prose, a stray character or a
 * cut-off object now and then (round three stopped twice on "not JSON", the
 * first Action round once); the same request asked again almost always comes
 * back whole, and a judging that dies on it throws away the run's money.
 */
export const JUDGE_ATTEMPTS = 3;

/** A reply the judge got wrong in a way asking again can fix. */
class MalformedReply extends Error {}

/** The verdicts for every answer in one request, or an error naming only the question. */
async function judgeQuestion({ send, body, checks, answers, n }) {
  let lastError = null;
  for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt += 1) {
    try {
      return await judgeOnce({ send, body, checks, answers, n });
    } catch (error) {
      if (!(error instanceof MalformedReply)) throw error;
      lastError = error;
    }
  }
  throw new Error(`${lastError.message} (${JUDGE_ATTEMPTS} attempts)`);
}

async function judgeOnce({ send, body, checks, answers, n }) {
  const response = await send(body);
  if (!response.ok) {
    const reply = await response.json().catch(() => ({}));
    const detail = reply?.error?.message ? ` (${reply.error.message})` : "";
    throw new Error(`judge call for question ${n} failed: status ${response.status}${detail}`);
  }
  const reply = await response.json();
  const text = (reply.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
  let parsed;
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    const why = reply.stop_reason === "max_tokens" ? "was cut off at max_tokens" : "is not JSON";
    throw new MalformedReply(`judge reply for question ${n} ${why}`);
  }
  const entries = new Map((Array.isArray(parsed?.answers) ? parsed.answers : []).map((entry) => [entry?.id, entry]));
  const blocks = answers.map((answer) => {
    const entry = entries.get(answer.id);
    if (!entry) throw new MalformedReply(`judge gave no verdicts for answer ${answer.id} (question ${n})`);
    if (!Array.isArray(entry.verdicts) || entry.verdicts.length !== checks.length) {
      throw new MalformedReply(`judge gave ${entry.verdicts?.length ?? 0} verdicts for ${checks.length} checks on answer ${answer.id}`);
    }
    if (entry.verdicts.some((v) => typeof v?.does !== "boolean")) throw new MalformedReply(`judge verdict for answer ${answer.id} has no does: true or false`);
    // The gate is not the judge's opinion (decided 2026-10-09): it follows from
    // the must-not lines in the score, so a gate failure can always be pointed
    // at. The judge grades lines, which it does well; Haiku's separate yes or
    // no flagged answers with every line passed and missed "I'll text Ana".
    return {
      id: answer.id,
      // The judge says whether the answer does what a line says; pass or fail
      // is worked out here, so a must-not line is never graded by a model
      // deciding what "pass" means for a forbidden thing. Decided 2026-10-10
      // after Haiku failed "say Maya is free for the show" on every run of an
      // answer its own reason called "not free, so the must not is avoided".
      verdicts: checks.map((check, i) => ({ kind: check.kind, line: check.line, pass: check.kind === "must not" ? !entry.verdicts[i].does : entry.verdicts[i].does, reason: String(entry.verdicts[i].reason ?? "") })),
      gate: null,
    };
  });
  const usage = { input: reply.usage?.input_tokens ?? 0, output: reply.usage?.output_tokens ?? 0 };
  return { blocks, usage };
}

/** Where a judging keeps its verdicts while it runs, so a stop costs nothing. */
export const sidecarPath = (path) => `${path}.judging.json`;

async function readSidecar(path, model) {
  try {
    const saved = JSON.parse(await readFile(sidecarPath(path), "utf8"));
    return saved?.model === model && saved.blocks && typeof saved.blocks === "object" ? saved : null;
  } catch {
    return null;
  }
}

/** Runs `work` over `items` with at most `limit` in flight, in order of start. */
async function inFlight(items, limit, work) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length) await work(queue.shift());
  });
  await Promise.all(workers);
}

/**
 * Judges every answer in one result note and appends the section. Verdicts
 * are saved per question as they arrive; a judging stopped partway resumes
 * from them. Returns the model, the counts and what was spent.
 */
export async function judgeFile({ path, dir, send, model, date = today(), maxUsd = DEFAULT_MAX_USD, concurrency = DEFAULT_CONCURRENCY, log = () => {} }) {
  const raw = await readFile(path, "utf8");
  const front = frontMatter(raw);
  if (!front.test) throw new Error(`${path} has no test: line in its front matter`);
  const test = parseTest(await readFile(join(dir, "tests", `${front.test}.md`), "utf8"));
  const judgeModel = model ?? test.front.judge ?? DEFAULT_JUDGE;

  // Answers by question; the ones the model never gave are skipped, never sent.
  const byQuestion = new Map();
  const skipped = [];
  for (const answer of parseResult(raw).answers) {
    if (isUnanswered(answer)) {
      skipped.push({ id: answer.id, verdicts: [], gate: null, skipped: answer.error ? `no answer: ${answer.error}` : "no answer" });
      continue;
    }
    if (!byQuestion.has(answer.question)) byQuestion.set(answer.question, []);
    byQuestion.get(answer.question).push(answer);
  }

  const saved = await readSidecar(path, judgeModel);
  const done = new Map(Object.entries(saved?.blocks ?? {}));
  const requests = [];
  for (const [n, answers] of [...byQuestion].sort((a, b) => a[0] - b[0])) {
    if (answers.every((answer) => done.has(answer.id))) continue;
    const question = test.questions.find((q) => q.n === n);
    if (!question) throw new Error(`answers to question ${n} are in the result, but the test does not have it`);
    const { checks, body, inputTokens, outputTokens } = buildJudgeRequest({ model: judgeModel, question, answers, every: test.everyAnswer });
    requests.push({ n, answers, checks, body, inputTokens, outputTokens, gate: isGateQuestion(question) });
  }

  const estimate = estimateJudging(requests, judgeModel);
  const usd = estimate.usd === null ? "unknown (no price for this model)" : `about $${estimate.usd.toFixed(2)}`;
  log(`${estimate.requests} judge requests to ${judgeModel}, about ${estimate.inputTokens.toLocaleString()} tokens in, ${usd}; ${skipped.length} unanswered skipped${done.size ? `, ${done.size} answers already judged` : ""}`);
  if (send.route !== "fake" && requests.length > 0) {
    if (estimate.usd === null && maxUsd === DEFAULT_MAX_USD) throw new Error(`no price is known for ${judgeModel}; pass --max-usd <n> to accept the spend`);
    if (estimate.usd !== null && estimate.usd > maxUsd) throw new Error(`estimated $${estimate.usd.toFixed(2)} is over the --max-usd ${maxUsd.toFixed(2)} cap; raise it to go ahead`);
  }

  const spent = { input: 0, output: 0, usd: 0 };
  let finished = 0;
  await inFlight(requests, concurrency, async (request) => {
    const started = Date.now();
    const { blocks, usage } = await judgeQuestion({ send, ...request });
    for (const block of blocks) done.set(block.id, block);
    spent.input += usage.input;
    spent.output += usage.output;
    spent.usd += priceOf(judgeModel, usage) ?? 0;
    finished += 1;
    await writeFile(sidecarPath(path), JSON.stringify({ model: judgeModel, blocks: Object.fromEntries(done) }));
    log(`q${request.n}: ${blocks.length} answers judged in ${((Date.now() - started) / 1000).toFixed(1)} s (${finished}/${requests.length}, spent $${spent.usd.toFixed(2)})`);
  });

  const order = parseResult(raw).answers.map((answer) => answer.id);
  const skippedById = new Map(skipped.map((block) => [block.id, block]));
  const blocks = order.map((id) => done.get(id) ?? skippedById.get(id)).filter(Boolean);
  const section = judgedSection({ model: judgeModel, date, blocks });
  const updated = `${setFrontStatus(raw, "judged").replace(/\n*$/, "\n")}\n${section}`;
  await writeFile(path, updated);
  await rm(sidecarPath(path), { force: true });
  return { model: judgeModel, judged: done.size, skipped: skipped.length, requests: requests.length, spent };
}

/**
 * A scripted judge with the same transport shape as claudeTransport: it reads
 * the payload it is sent and passes a check when an answer's assistant text
 * contains one of the check's words longer than five letters. Plumbing only.
 */
export function fakeJudge() {
  const send = async (body) => {
    const content = JSON.parse(body).messages[0].content;
    const payload = JSON.parse(content.slice(content.indexOf("<answers>") + "<answers>".length, content.indexOf("</answers>")));
    const answers = payload.answers.map((answer) => {
      const said = answer.conversation
        .filter((turn) => turn.from === "assistant")
        .map((turn) => turn.text)
        .join(" ")
        .toLowerCase();
      const verdicts = payload.checks.map((check) => {
        const hit = check.line
          .split(/[^A-Za-z]+/)
          .filter((word) => word.length > 5)
          .find((word) => said.includes(word.toLowerCase()));
        return { line: check.line, does: hit !== undefined, reason: hit ? `the answer has "${hit}"` : "the answer has none of its long words" };
      });
      return { id: answer.id, verdicts, gate_failed: false };
    });
    const reply = { content: [{ type: "text", text: JSON.stringify({ answers }) }], usage: { input_tokens: 10, output_tokens: 5 } };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  send.route = "fake";
  return send;
}

/** The `judge` command: options come from run.mjs's argument parser. */
export async function judgeCommand(options) {
  const dir = benchFolder(options);
  if (!options.job || !dir) throw new Error("usage: pnpm ai judge <result file> --dir <benchmarks folder> [--judge <model>] [--max-usd <n>] [--concurrency <n>] [--fake]");
  const send = options.fake ? fakeJudge() : claudeTransport(process.env);
  if (!options.fake) {
    process.stderr.write(`Judge calls: ${send.route === "gateway" ? "through the AI gateway" : send.route === "anthropic" ? "straight to Anthropic" : "no keys set"}\n`);
  }
  const maxUsd = options["max-usd"] === undefined ? DEFAULT_MAX_USD : Number(options["max-usd"]);
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error(`--max-usd must be a number of dollars, got "${options["max-usd"]}"`);
  const concurrency = options.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(options.concurrency);
  const model = options.fake ? (options.judge ?? "fake-judge") : options.judge;
  const result = await judgeFile({ path: options.job, dir, send, model, date: today(), maxUsd, concurrency, log: (line) => process.stderr.write(`${line}\n`) });
  process.stderr.write(`judged ${result.judged} answers with ${result.model} in ${result.requests} requests, skipped ${result.skipped} unanswered, spent $${result.spent.usd.toFixed(2)}; appended to ${options.job}\n`);
}
