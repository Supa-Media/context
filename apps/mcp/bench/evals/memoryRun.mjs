/**
 * A MEMORY RUN: CONTEXT AS AN AI CLIENT'S MEMORY (Dev2, 2026-11-20: "LongMemEval is primarily for context, its not
 * supposed to test tex"; chose "Save each session raw, then file"). Any benchmark folder's BEIR set runs this way
 * (`memoryCases` in `packages/bench/src/beir.mjs`): its dated documents are the past sessions, each query's `answer`
 * what the judge grades against (Dev2, 2026-11-21: "reuse formats for all of our benchmarks").
 *
 * One question is one throwaway world (`../world.mjs`): the real gateway Worker in this process, over the in-memory
 * control plane and buckets, with one person and an empty personal workspace. Then, as a memory layer is measured:
 *
 *   1. Each past session is saved raw, at its own time, as an AI client saves one: `write` `save_session` with the
 *      whole visible transcript (the clock set back to the session's date, so the note is dated then).
 *   2. Context files what arrived the way it does for a person: housekeeping (`src/agent/housekeeping.js`, PARA
 *      organizing) runs `filings` times across the history, the last just before the question.
 *   3. A fresh reader client, which saw none of it, is asked the question on its date. It has the Context MCP
 *      endpoint's own instructions and tools, nothing else, and answers when it is done looking.
 *   4. The benchmark's own judge prompt grades the answer (its `source.mjs` `judgePrompt`, LongMemEval's for it),
 *      or a plain "does the response contain the answer" one when it has none.
 *
 * Every model call goes through one `send(body)` (`claudeTransport`, or the model socket for a Claude Code run), so
 * a run is priced per phase: saving costs nothing, filing is housekeeping's turns, reading is the reader's rounds.
 */

import { PRODUCTION_HOUSEKEEPING_PATH } from "../../../../packages/tex/gateway/agent/production.js";
import { atEarlierTime } from "../clock.mjs";
import { anthropicGateway } from "../models.mjs";
import { prepareRun } from "../warm.mjs";
import { createWorld } from "../world.mjs";
import { usdOf } from "../../../../packages/bench/benchmarks/longmemeval/source.mjs";

const DAY_MS = 86_400_000;

/** The one person each question's world has, and their empty personal workspace. */
export const EVAL_PERSON = "Sam";
export const EVAL_WORKSPACE = "sam";
export const evalBench = () => ({
  people: [{ person: EVAL_PERSON, workspace: EVAL_WORKSPACE, personal: true, role: "owner" }],
  workspaces: { [EVAL_WORKSPACE]: { files: {}, heldBack: [], calendar: [], mail: [], generated: [] } },
  tests: {},
});

/** A texting setup the world needs; no word of it reaches a save, a filing run or the reader. */
const PLAIN_TEXTING_SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

export const DEFAULTS = Object.freeze({
  reader: "claude-haiku-5-5",
  judge: "claude-sonnet-5-5",
  filings: 4,
  readerRounds: 12,
  readerTokens: 2_000,
});

/** The platform slug the saves carry, the client that wrote them, when the run names none: the benchmark's id. */
const PLATFORM = "longmemeval";

/** The judge's prompt a benchmark with none of its own gets: does the response hold the answer. */
export function plainJudgePrompt({ question, answer }, response) {
  return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
}

/** The judge's rule (LongMemEval's): correct when its answer contains "yes". */
export const verdictOf = (text) => /yes/i.test(String(text ?? ""));

/** The day a time falls on, as the world's clock takes it. */
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

/** A Messages API call through `send`, its reply and what it spent. Never throws: a refusal is its words. */
async function ask(send, body) {
  try {
    const response = await send(JSON.stringify(body));
    const reply = await response.json().catch(() => null);
    if (response.status !== 200 || !reply) return { reply: null, error: `${response.status} ${reply?.error?.message ?? reply?.error?.type ?? ""}`.trim(), usage: null };
    const u = reply.usage ?? {};
    const usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
    return { reply, error: null, usage };
  } catch (error) {
    return { reply: null, error: String(error?.message ?? error).slice(0, 300), usage: null };
  }
}

/** About four characters to a token: the estimate a call with no usage (the Claude Code socket answers none) is priced at. */
const CHARS_PER_TOKEN = 4;

/**
 * `send` with every call priced into the phase it ran in: the reader's and the judge's, and the world's own (filing
 * runs reach Claude through the same `send`). A reply with no usage, as the model socket answers, is priced from its
 * characters and the phase marked estimated, so a $0 Claude Code run still says what the gateway would have cost.
 */
export function meteredSend(send) {
  const usd = { filing: 0, reading: 0, judging: 0 };
  // Tokens per phase, reported or estimated as `usd` is: what a Claude Code run shows per question in place of dollars.
  const tokens = { filing: 0, reading: 0, judging: 0 };
  let phase = "filing";
  let estimated = false;
  const metered = async (body) => {
    const response = await send(body);
    try {
      const request = JSON.parse(typeof body === "string" ? body : JSON.stringify(body));
      const reply = await response.clone().json();
      const u = reply?.usage ?? {};
      let usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
      if (response.status === 200 && usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) {
        const sent = JSON.stringify({ system: request.system ?? "", messages: request.messages ?? [], tools: request.tools ?? [] }).length;
        usage = { input: Math.ceil(sent / CHARS_PER_TOKEN), output: Math.ceil(JSON.stringify(reply?.content ?? []).length / CHARS_PER_TOKEN), cacheRead: 0, cacheWrite: 0 };
        estimated = true;
      }
      usd[phase] += usdOf(request.model, usage);
      tokens[phase] += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    } catch {
      // An unreadable reply costs what the caller reads of it: nothing counted here.
    }
    return response;
  };
  metered.route = send.route;
  return { send: metered, usd, tokens, phase: (name) => (phase = name), estimated: () => estimated };
}

const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim() : "");
const toolText = (result) =>
  result?.result?.content ? result.result.content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n") : JSON.stringify(result?.error ?? result ?? null);

/** The reader's system prompt: the date, and the Context endpoint's own words to a connected client. */
export function readerSystem(instructions, askedAt) {
  const when = new Date(askedAt).toUTCString().replace(" GMT", " UTC");
  return [`Current date and time: ${when}.`, "The user has connected their Context: the memory every AI client they use reads and writes. Use it to answer them.", instructions].filter(Boolean).join("\n\n");
}

/**
 * The reader: a fresh client that answers `question` with only the world's MCP tools. Returns its answer, the calls
 * it made, and its usage summed over rounds.
 */
export async function readAndAnswer(world, send, { question, askedAt, model = DEFAULTS.reader, rounds = DEFAULTS.readerRounds, maxTokens = DEFAULTS.readerTokens }) {
  const init = await world.mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "longmemeval-reader", version: "1" } });
  const listed = await world.mcp("tools/list", {});
  const tools = (listed?.result?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description ?? "", input_schema: tool.inputSchema ?? { type: "object" } }));
  const system = readerSystem(init?.result?.instructions ?? "", askedAt);
  const messages = [{ role: "user", content: question }];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const calls = [];
  // Everything the reader said this turn, as the person would read it: an answer followed by "I saved that" is
  // still the answer, and grading only the last line graded the save notice (the first slice, 2026-11-20).
  const spoken = [];
  for (let round = 0; round < rounds; round += 1) {
    const last = round === rounds - 1;
    const got = await ask(send, { model, max_tokens: maxTokens, system, messages, ...(last ? {} : { tools }) });
    if (got.usage) for (const key of Object.keys(usage)) usage[key] += got.usage[key];
    if (!got.reply) return { answer: "", error: got.error, calls, usage, rounds: round + 1 };
    const content = Array.isArray(got.reply.content) ? got.reply.content : [];
    const uses = content.filter((b) => b?.type === "tool_use");
    const said = textOf(content);
    if (said) spoken.push(said);
    if (uses.length === 0) return { answer: spoken.join("\n\n"), error: null, calls, usage, rounds: round + 1 };
    messages.push({ role: "assistant", content });
    const results = [];
    for (const use of uses) {
      const result = await world.mcp("tools/call", { name: use.name, arguments: use.input ?? {} });
      const text = toolText(result);
      calls.push({ tool: use.name, input: use.input ?? {}, chars: text.length, error: Boolean(result?.result?.isError || result?.error) });
      results.push({ type: "tool_result", tool_use_id: use.id, content: text.slice(0, 60_000), ...(result?.result?.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return { answer: "", error: "no answer within the reader's rounds", calls, usage, rounds };
}

/** The judge on one answer (`prompt`: the benchmark's own, or the plain one): its verdict and what it said. */
export async function judge(send, c, answer, model = DEFAULTS.judge, prompt = plainJudgePrompt) {
  const text = prompt({ id: c.id, type: c.kind, question: c.question, answer: c.answer }, answer || "(no answer)");
  const got = await ask(send, { model, max_tokens: 10, temperature: 0, messages: [{ role: "user", content: text }] });
  const said = got.reply ? textOf(got.reply.content) : "";
  return { correct: got.reply ? verdictOf(said) : null, said, error: got.error, usage: got.usage };
}

/**
 * The times housekeeping runs over this history: `filings` runs, evenly spaced from a step after the first session
 * to just before the question, the last always just before it. A bounded count, not a calendar cadence: one
 * question's sessions span weeks to years, and a filing run is a model turn.
 */
export function filingTimes(sessions, askedAt, filings) {
  const count = Number.isSafeInteger(filings) ? Math.max(0, filings) : DEFAULTS.filings;
  if (sessions.length === 0 || count === 0) return [];
  const first = sessions[0].at;
  const last = askedAt - 60_000;
  if (!(last > first)) return [last];
  const step = (last - first) / count;
  return Array.from({ length: count }, (_, k) => Math.round(first + step * (k + 1)));
}

/**
 * One question, end to end: a memory case (`memoryCases`: `{ id, kind, ability, question, answer, date, asked,
 * sessions: [{ id, at, title, content }] }`). `models.send` is how Claude is reached; `models.ai` the world's Workers
 * AI (embeddings and small models); `models.housekeeping` an optional setup note for the filing runs. `options`
 * takes `judgePrompt` (the benchmark's own) and `platform` (the saves' client) beside the defaults. Returns the row a
 * run keeps.
 */
export async function runQuestion(c, models, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const sessions = c.sessions ?? [];
  const askedAt = (c.date && Number.isFinite(Date.parse(c.date)) ? Date.parse(c.date) : null) ?? (sessions.at(-1)?.at ?? 0) + DAY_MS;
  const started = Date.now();
  const row = {
    id: c.id,
    type: c.kind,
    ability: c.ability,
    question: c.question,
    expected: String(c.answer ?? ""),
    date: c.asked ?? c.date ?? null,
    sessions: sessions.length,
    saved: 0,
    saveErrors: 0,
    filings: 0,
    filingErrors: 0,
    answer: "",
    correct: null,
    judgeSaid: "",
    calls: [],
    usd: { filing: 0, reading: 0, judging: 0 },
    error: null,
    ms: 0,
  };
  const meter = meteredSend(models.send);
  const send = meter.send;
  const worldModels = {
    gatewayFetch: anthropicGateway(send, () => {}),
    ...(models.ai ? { ai: models.ai } : {}),
    clock: hhmm(askedAt),
    timeZone: "UTC",
    ...(models.housekeeping ? { pinnedNotes: [{ path: PRODUCTION_HOUSEKEEPING_PATH, raw: models.housekeeping }] } : {}),
  };
  // Warm, as production is: the workspace starts with its search database and meaning index (empty here), so every
  // save is indexed whole and by meaning. A cold world has neither and searches by a budgeted scan of each note's
  // first 2,048 characters, which is not what a person's Context searches with (the first slice's misses, 2026-11-20).
  const prepared = await prepareRun(evalBench(), { today: isoDay(askedAt), ai: models.ai ?? null });
  const world = await createWorld(evalBench(), EVAL_PERSON, PLAIN_TEXTING_SETUP, worldModels, isoDay(askedAt), prepared).catch((error) => {
    prepared.close();
    throw error;
  });
  try {
    const filings = filingTimes(sessions, askedAt, opts.filings);
    const fileUntil = async (until) => {
      while (filings.length > 0 && filings[0] <= until) {
        const at = filings.shift();
        const done = await atEarlierTime(Date.now() - at, () => world.keepHouse());
        row.filings += 1;
        if (!done.ok) row.filingErrors += 1;
      }
    };
    for (const session of sessions) {
      await fileUntil(session.at);
      const saved = await atEarlierTime(Date.now() - session.at, () =>
        world.mcp("tools/call", {
          name: "write",
          arguments: { action: "save_session", content: session.content, args: { platform: opts.platform ?? PLATFORM, completeness: "full-visible-transcript", title: session.title || `Chat ${isoDay(session.at)} ${hhmm(session.at)}`, session_id: session.id } },
        }),
      );
      if (saved?.result && !saved.result.isError) row.saved += 1;
      else row.saveErrors += 1;
    }
    await fileUntil(askedAt);
    meter.phase("reading");
    const read = await readAndAnswer(world, send, { question: c.question, askedAt, model: opts.reader, rounds: opts.readerRounds, maxTokens: opts.readerTokens });
    row.answer = read.answer;
    row.calls = read.calls;
    if (read.error) row.error = `reader: ${read.error}`;
    meter.phase("judging");
    const verdict = await judge(send, c, read.answer, opts.judge, opts.judgePrompt ?? plainJudgePrompt);
    row.correct = verdict.correct;
    row.judgeSaid = verdict.said;
    if (verdict.error) row.error = [row.error, `judge: ${verdict.error}`].filter(Boolean).join("; ");
  } catch (error) {
    row.error = String(error?.stack ?? error).slice(0, 500);
  } finally {
    world.close();
    prepared.close();
  }
  row.usd = { ...meter.usd };
  row.tokens = { ...meter.tokens };
  row.usdEstimated = meter.estimated();
  row.ms = Date.now() - started;
  return row;
}

/**
 * A run's scores: overall, per ability and per question type; graded rows only. `abilities` is the benchmark's list in
 * its order (LongMemEval's five), else the abilities the rows have.
 */
export function scoresOf(rows, abilities = null) {
  const graded = rows.filter((row) => row.correct === true || row.correct === false);
  const share = (list) => ({ n: list.length, correct: list.filter((row) => row.correct).length, pct: list.length ? Math.round((1000 * list.filter((row) => row.correct).length) / list.length) / 10 : null });
  const ids = abilities ? abilities.map((a) => a.id) : [...new Set(rows.map((row) => row.ability))].sort();
  const byAbility = Object.fromEntries(ids.map((id) => [id, share(graded.filter((row) => row.ability === id))]));
  const types = [...new Set(graded.map((row) => row.type))].sort();
  const byType = Object.fromEntries(types.map((type) => [type, share(graded.filter((row) => row.type === type && row.ability !== "abstention"))]));
  const usd = rows.reduce((sum, row) => ({ filing: sum.filing + row.usd.filing, reading: sum.reading + row.usd.reading, judging: sum.judging + row.usd.judging }), { filing: 0, reading: 0, judging: 0 });
  const estimated = rows.some((row) => row.usdEstimated === true);
  return { ...share(graded), asked: rows.length, failed: rows.filter((row) => row.error && row.correct === null).length, byAbility, byType, usd: { ...usd, total: usd.filing + usd.reading + usd.judging, estimated } };
}
