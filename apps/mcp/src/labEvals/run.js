/**
 * ONE EVAL RUN, MOVED ALONG (decision `docs/decisions/texting-assistant/lab-evals.md`).
 *
 * A run is a slice of a benchmark's questions on main or a Lab draft. Each question goes through real Tex as a Lab
 * test chat does (`labSandbox/`), in four steps:
 *
 *   1. its past chats become a test chat's history (`longMemEval.js` `historyOf`): the person's 1:1 session with none
 *      of their notes, mail or calendar (`policy.js` `BLANK_READS`), every past day dated as LongMemEval dates it, moved
 *      so the question is asked today;
 *   2. each finished day is summed up as the night does in production (`daySummaries.js`, the same model and prompt),
 *      so the turn reads 7 days whole and the days before as summaries, and `read_day` reads any of them whole;
 *   3. the question is texted, and the chat object runs the turn as a text from the person (Triage, the front door,
 *      its checks, the line), in the test chat's own object;
 *   4. once Tex's reply is in, LongMemEval's judge prompt for the question's type grades it (`judgePrompt`).
 *
 * Nothing runs on its own: a driver moves the run along with `advance` (the Lab while it is open, or `tex_dev evals`),
 * which grades what has answered and starts the next questions, a few at a time. The caller's grant is used only
 * inside each call, as the test chats use it; nothing keeps it. A run with no driver waits where it is.
 */

import { aiGatewayConfig, requestViaGateway } from "../agent/aiGateway.js";
import { writeChatDaySummaries } from "../agent/daySummaries.js";
import { ONE_TO_ONE_CHAT } from "../agent/ledger.js";
import { callSandbox, sandboxStub } from "../labSandbox/object.js";
import { fetchItem } from "./dataset.js";
import { historyOf, judgePrompt, stepUsd, usdOf, verdictOf } from "./longMemEval.js";
import { callEvals, FINISHED } from "./store.js";

/** The judge: LongMemEval graded with GPT-4o; here the closest allowed model, then Haiku if it is refused. */
export const JUDGE_MODELS = ["anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5"];
/** Questions open at once in a run, and started by one `advance`. */
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 8;
export const STARTS_PER_ADVANCE = 2;
/** A question whose test chat never finished opening, a reply still running past this, and a quiet turn's grace. */
const OPENING_STALE_MS = 10 * 60_000;
export const ANSWER_LIMIT_MS = 15 * 60_000;
const QUIET_GRACE_MS = 90_000;
/** How long one driver holds an asked question while it looks at it. */
const CHECK_LEASE_MS = 45_000;
const ANSWER_CHARS = 4_000;
/** Day summaries asked at once for one question (production sums four a night at a time). */
const SUMMARIES_AT_ONCE = 10;

const words = (error) => String(error?.message ?? error ?? "failed").slice(0, 300);

/**
 * `deps`: `{ env, stub (the evals object), who, token, origin, open (labSandbox/route.js), sandbox(body) (one call to
 * the test-chat route, answering { ok, status, answer }), fetchImpl?, request?, now? }`.
 */
export async function advance(deps, runId) {
  const now = deps.now ?? Date.now;
  const { run } = await callEvals(deps.stub, "run", { id: runId, items: false });
  if (!run) return { error: [404, "There is no such eval run."] };
  if (run.status !== "running") return { run };
  const checks = (await callEvals(deps.stub, "checks", { run: runId, now: now(), leaseMs: CHECK_LEASE_MS })).items ?? [];
  const graded = (await Promise.all(checks.map((item) => checkOne(deps, run, item).catch((error) => ({ qid: item.qid, state: "failed", error: words(error), doneAt: now() }))))).filter(Boolean);
  if (graded.length > 0) await callEvals(deps.stub, "items.put", { run: runId, items: graded });
  const claimed = (await callEvals(deps.stub, "claim", { run: runId, max: run.concurrency ?? DEFAULT_CONCURRENCY, take: STARTS_PER_ADVANCE, now: now(), staleMs: OPENING_STALE_MS })).items ?? [];
  const started = await Promise.all(claimed.map((item) => startOne(deps, run, item)));
  if (started.length > 0) await callEvals(deps.stub, "items.put", { run: runId, items: started });
  const { items } = await callEvals(deps.stub, "run", { id: runId });
  if (items.length > 0 && items.every((item) => FINISHED.has(item.state))) {
    return { run: (await callEvals(deps.stub, "run.put", { run: { id: runId, status: "done", endedAt: now() } })).run, items };
  }
  return { run, items };
}

/** A ledger over a test chat's own (`object.js`), as the night's summaries read and write one. */
function sandboxLedger(stub) {
  return {
    read: (chat, options) => callSandbox(stub, "ledger.read", { chat, options }),
    append: (_chat, entries) => callSandbox(stub, "ledger.append", { entries }),
  };
}

/** Steps 1 to 3 for one question: answers its item as asked, or failed with why. */
export async function startOne(deps, run, item) {
  const now = deps.now ?? Date.now;
  const request = deps.request ?? requestViaGateway;
  try {
    const { source } = await callEvals(deps.stub, "source", { bench: run.bench });
    if (!source?.url) throw new Error("the benchmark's dataset is not read yet");
    const data = await fetchItem(source.url, { id: item.qid, start: item.start, end: item.end }, deps.fetchImpl ?? fetch);
    const timeZone = typeof deps.who?.timeZone === "string" && deps.who.timeZone !== "" ? deps.who.timeZone : "UTC";
    const built = historyOf(data, { now: now(), timeZone });
    const opened = await deps.open({ source: "eval", versionId: run.versionId ?? "main", seed: { rows: built.rows, history: built.history }, by: run.by });
    const body = await opened.json().catch(() => ({}));
    if (!opened.ok || typeof body.sandboxId !== "string") throw new Error(body.error ?? `its test chat did not open (${opened.status})`);
    // The night's day summaries, as production writes them, for every finished day of the history.
    const spent = { usd: 0, calls: 0 };
    const counted = async (call, config, options) => {
      const reply = await request(call, config, options);
      spent.usd += usdOf(call.model, reply?.usage);
      spent.calls += 1;
      return reply;
    };
    const stub = sandboxStub(deps.env, deps.who.userId, body.sandboxId);
    const summed = await writeChatDaySummaries({ ledger: sandboxLedger(stub), chat: ONE_TO_ONE_CHAT, now: now(), timeZone, config: aiGatewayConfig(deps.env), request: counted, metadata: { feature: "lab-eval-day-summary" }, max: 1_000, atOnce: SUMMARIES_AT_ONCE, log: () => {} });
    const sent = await deps.sandbox({ op: "send", sandboxId: body.sandboxId, text: String(data.question ?? ""), by: run.by });
    if (!sent.ok || typeof sent.answer?.msgId !== "string") throw new Error(sent.answer?.error ?? `the question was not sent (${sent.status})`);
    return {
      qid: item.qid,
      state: "asked",
      sandboxId: body.sandboxId,
      msgId: sent.answer.msgId,
      askedAt: now(),
      question: String(data.question ?? ""),
      gold: String(data.answer ?? ""),
      questionDate: String(data.question_date ?? ""),
      shiftDays: built.shiftDays,
      sessions: built.sessions,
      turns: built.turns,
      days: built.days,
      summaries: summed?.written ?? 0,
      summaryUsd: spent.usd,
    };
  } catch (error) {
    return { qid: item.qid, state: "failed", error: words(error), doneAt: now() };
  }
}

/** The judge's answer: the first judge model that answers, LongMemEval's prompt for this question. */
async function judge(deps, item, response) {
  const request = deps.request ?? requestViaGateway;
  const config = aiGatewayConfig(deps.env);
  const prompt = judgePrompt({ id: item.qid, type: item.type, question: item.question, answer: item.gold }, response, item.shiftDays ?? 0);
  let last = null;
  for (const model of JUDGE_MODELS) {
    try {
      const reply = await request({ model, system: "You grade answers for a benchmark. Answer yes or no only.", messages: [{ role: "user", text: prompt }], tools: [], maxTokens: 16, effort: "low" }, config, { metadata: { feature: "lab-eval-judge" } });
      return { text: String(reply?.text ?? "").trim().slice(0, 200), model, usd: usdOf(model, reply?.usage) };
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`no judge answered: ${words(last)}`);
}

/** Step 4 for one asked question: null while Tex is still answering, else its item graded (or failed). */
export async function checkOne(deps, run, item) {
  const now = (deps.now ?? Date.now)();
  const got = await deps.sandbox({ op: "get", sandboxId: item.sandboxId });
  if (!got.ok) return got.status === 404 ? { qid: item.qid, state: "failed", error: "its test chat is gone", doneAt: now } : null;
  const rows = Array.isArray(got.answer?.rows) ? got.answer.rows : [];
  const at = rows.findIndex((row) => row.id === item.msgId);
  if (at < 0) return { qid: item.qid, state: "failed", error: "its question is not in the test chat", doneAt: now };
  const after = rows.slice(at + 1);
  const replies = after.filter((row) => row.who === "Tex" && !row.kind && typeof row.text === "string" && row.text.trim() !== "");
  const running = got.answer?.running !== null && got.answer?.running !== undefined;
  const waited = now - (item.askedAt ?? now);
  if (running && waited < ANSWER_LIMIT_MS) return null;
  if (!running && replies.length === 0 && waited < QUIET_GRACE_MS) return null;
  const answer = replies.map((row) => row.text.trim()).join("\n").slice(0, ANSWER_CHARS);
  const steps = [rows[at], ...after].flatMap((row) => (Array.isArray(row.steps) ? row.steps : []));
  const turnUsd = steps.reduce((sum, step) => sum + stepUsd(step), 0);
  const tokens = steps.reduce((sum, step) => sum + (Number.isFinite(step?.tokIn) ? step.tokIn : 0) + (Number.isFinite(step?.tokOut) ? step.tokOut : 0), 0);
  const graded = await judge(deps, item, answer === "" ? "(no reply)" : answer);
  return {
    qid: item.qid,
    state: "graded",
    answer,
    correct: verdictOf(graded.text),
    judge: graded.text,
    judgeModel: graded.model,
    judgeUsd: graded.usd,
    turnUsd,
    tokens,
    steps: steps.length,
    replyMs: replies.length > 0 && Number.isFinite(replies[0].at) && Number.isFinite(rows[at].at) ? replies[0].at - rows[at].at : null,
    doneAt: now,
    ...(running ? { note: "Tex was still answering after 15 minutes: graded on what it had said" } : replies.length === 0 ? { note: "Tex sent no reply" } : {}),
  };
}

// ── Scores ─────────────────────────────────────────────────────────────────

const pct = (right, total) => (total > 0 ? Math.round((1000 * right) / total) / 10 : null);

/** A run's scores from its items: overall, per ability and per type, its spend and time, and how far it got. */
export function scoresOf(items) {
  const graded = items.filter((item) => item.state === "graded");
  const right = graded.filter((item) => item.correct === true).length;
  const group = (key) => {
    const out = {};
    for (const item of graded) {
      const k = item[key] ?? "?";
      out[k] ??= { right: 0, total: 0 };
      out[k].total += 1;
      if (item.correct === true) out[k].right += 1;
    }
    for (const k of Object.keys(out)) out[k].pct = pct(out[k].right, out[k].total);
    return out;
  };
  const usd = items.reduce((sum, item) => sum + (item.turnUsd ?? 0) + (item.summaryUsd ?? 0) + (item.judgeUsd ?? 0), 0);
  const times = graded.map((item) => item.replyMs).filter((ms) => Number.isFinite(ms)).sort((a, b) => a - b);
  return {
    pct: pct(right, graded.length),
    right,
    graded: graded.length,
    failed: items.filter((item) => item.state === "failed").length,
    running: items.filter((item) => item.state === "opening" || item.state === "asked").length,
    waiting: items.filter((item) => item.state === "waiting").length,
    total: items.length,
    byAbility: group("ability"),
    byType: group("type"),
    usd: Math.round(usd * 10_000) / 10_000,
    usdPerQuestion: graded.length > 0 ? Math.round((usd / Math.max(1, graded.length + items.filter((i) => i.state === "failed").length)) * 10_000) / 10_000 : null,
    medianReplyMs: times.length > 0 ? times[Math.floor(times.length / 2)] : null,
  };
}
