/**
 * LONGMEMEVAL'S RUN: CONTEXT AS AN AI CLIENT'S MEMORY (Dev2, 2026-11-20: "LongMemEval is primarily for context, its
 * not supposed to test tex"; chose "Save each session raw, then file").
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
 *   4. LongMemEval's own judge prompt grades the answer.
 *
 * Every model call goes through one `send(body)` (`claudeTransport`, or the model socket for a Claude Code run), so
 * a run is priced per phase: saving costs nothing, filing is housekeeping's turns, reading is the reader's rounds.
 */

import { PRODUCTION_HOUSEKEEPING_PATH } from "../../src/agent/production.js";
import { atEarlierTime } from "../clock.mjs";
import { anthropicGateway } from "../models.mjs";
import { createWorld } from "../world.mjs";
import { ABILITIES, abilityOf, judgePrompt, sessionsOf, transcriptOf, usdOf, utcMs, verdictOf } from "./longMemEval.mjs";

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

/** The platform slug the saves carry: the client that wrote them. */
const PLATFORM = "longmemeval";

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
  for (let round = 0; round < rounds; round += 1) {
    const last = round === rounds - 1;
    const got = await ask(send, { model, max_tokens: maxTokens, system, messages, ...(last ? {} : { tools }) });
    if (got.usage) for (const key of Object.keys(usage)) usage[key] += got.usage[key];
    if (!got.reply) return { answer: "", error: got.error, calls, usage, rounds: round + 1 };
    const content = Array.isArray(got.reply.content) ? got.reply.content : [];
    const uses = content.filter((b) => b?.type === "tool_use");
    if (uses.length === 0) return { answer: textOf(content), error: null, calls, usage, rounds: round + 1 };
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

/** LongMemEval's judge on one answer: its verdict and what it said. */
export async function judge(send, item, answer, model = DEFAULTS.judge) {
  const prompt = judgePrompt({ id: item.question_id, type: item.question_type, question: item.question, answer: item.answer }, answer || "(no answer)");
  const got = await ask(send, { model, max_tokens: 10, temperature: 0, messages: [{ role: "user", content: prompt }] });
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
 * One question, end to end. `models.send` is how Claude is reached; `models.ai` the world's Workers AI (embeddings
 * and small models); `models.housekeeping` an optional setup note for the filing runs. Returns the row a run keeps.
 */
export async function runQuestion(item, models, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const sessions = sessionsOf(item);
  const askedAt = utcMs(item.question_date) ?? (sessions.at(-1)?.at ?? 0) + DAY_MS;
  const started = Date.now();
  const row = {
    id: item.question_id,
    type: item.question_type,
    ability: abilityOf(item.question_id, item.question_type),
    question: item.question,
    expected: String(item.answer ?? ""),
    date: item.question_date ?? null,
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
  const worldModels = {
    gatewayFetch: anthropicGateway(models.send, () => {}),
    ...(models.ai ? { ai: models.ai } : {}),
    clock: hhmm(askedAt),
    timeZone: "UTC",
    ...(models.housekeeping ? { pinnedNotes: [{ path: PRODUCTION_HOUSEKEEPING_PATH, raw: models.housekeeping }] } : {}),
  };
  const world = await createWorld(evalBench(), EVAL_PERSON, PLAIN_TEXTING_SETUP, worldModels, isoDay(askedAt));
  try {
    const filings = filingTimes(sessions, askedAt, opts.filings);
    const fileUntil = async (until) => {
      while (filings.length > 0 && filings[0] <= until) {
        const at = filings.shift();
        const done = await atEarlierTime(Date.now() - at, () => world.keepHouse());
        row.filings += 1;
        if (!done.ok) row.filingErrors += 1;
        row.usd.filing += usdOf(done.model, done.usage);
      }
    };
    for (const session of sessions) {
      await fileUntil(session.at);
      const saved = await atEarlierTime(Date.now() - session.at, () =>
        world.mcp("tools/call", {
          name: "write",
          arguments: { action: "save_session", content: transcriptOf(session), args: { platform: PLATFORM, completeness: "full-visible-transcript", title: `Chat ${isoDay(session.at)} ${hhmm(session.at)}`, session_id: session.id } },
        }),
      );
      if (saved?.result && !saved.result.isError) row.saved += 1;
      else row.saveErrors += 1;
    }
    await fileUntil(askedAt);
    const read = await readAndAnswer(world, models.send, { question: item.question, askedAt, model: opts.reader, rounds: opts.readerRounds, maxTokens: opts.readerTokens });
    row.answer = read.answer;
    row.calls = read.calls;
    row.usd.reading = usdOf(opts.reader, read.usage);
    if (read.error) row.error = `reader: ${read.error}`;
    const verdict = await judge(models.send, item, read.answer, opts.judge);
    row.correct = verdict.correct;
    row.judgeSaid = verdict.said;
    row.usd.judging = usdOf(opts.judge, verdict.usage);
    if (verdict.error) row.error = [row.error, `judge: ${verdict.error}`].filter(Boolean).join("; ");
  } catch (error) {
    row.error = String(error?.stack ?? error).slice(0, 500);
  } finally {
    world.close();
  }
  row.ms = Date.now() - started;
  return row;
}

/** A run's scores: overall, per ability (LongMemEval's five) and per question type; graded rows only. */
export function scoresOf(rows) {
  const graded = rows.filter((row) => row.correct === true || row.correct === false);
  const share = (list) => ({ n: list.length, correct: list.filter((row) => row.correct).length, pct: list.length ? Math.round((1000 * list.filter((row) => row.correct).length) / list.length) / 10 : null });
  const byAbility = Object.fromEntries(ABILITIES.map((a) => [a.id, share(graded.filter((row) => row.ability === a.id))]));
  const types = [...new Set(graded.map((row) => row.type))].sort();
  const byType = Object.fromEntries(types.map((type) => [type, share(graded.filter((row) => row.type === type && row.ability !== "abstention"))]));
  const usd = rows.reduce((sum, row) => ({ filing: sum.filing + row.usd.filing, reading: sum.reading + row.usd.reading, judging: sum.judging + row.usd.judging }), { filing: 0, reading: 0, judging: 0 });
  return { ...share(graded), asked: rows.length, failed: rows.filter((row) => row.error && row.correct === null).length, byAbility, byType, usd: { ...usd, total: usd.filing + usd.reading + usd.judging } };
}
