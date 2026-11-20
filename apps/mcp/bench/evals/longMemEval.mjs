/**
 * LONGMEMEVAL, AS A MEMORY TEST OF CONTEXT (Dev2, 2026-11-20: "create an evals tab one of them being the LongMemEval,
 * and build out the adapter for this eval"; "LongMemEval is primarily for context, its not supposed to test tex"; chose
 * "Save each session raw, then file"; decision `docs/decisions/testing/lab-evals.md`).
 *
 * LongMemEval (Wu et al., ICLR 2025, github.com/xiaowu0162/LongMemEval, MIT) is 500 questions, each with a long
 * history of past chats between a user and an assistant and one question about it. This file is the pure half of the
 * adapter, everything that needs no world and no model:
 *
 *  - `BENCHES`: the variants offered, each a file of the dataset on Hugging Face;
 *  - `entryOf` and `sliceOf`: a question's facts, and the same stratified slice of n questions every time, so two
 *    runs of one size compare;
 *  - `sessionsOf` and `transcriptOf`: the question's past sessions, oldest first, each at its own time, as the
 *    Markdown transcript an AI client saves with `save_context`;
 *  - `judgePrompt` and `verdictOf`: LongMemEval's own grading prompts (its `evaluate_qa.py`), one per question type,
 *    and its rule (the judge's answer contains "yes");
 *  - `usdOf`: what a call cost.
 */

/** The variants offered: the standard S file (about 115k tokens of history each) and the oracle (evidence only). */
export const BENCHES = Object.freeze([
  {
    id: "longmemeval-s",
    title: "LongMemEval",
    variant: "S",
    repo: "xiaowu0162/longmemeval-cleaned",
    file: /longmemeval_s/i,
    about: "500 questions, each after about 50 past chat sessions (about 115k tokens): recall a fact, connect facts across sessions, reason about time, follow a fact that changed, and say \"I don't know\".",
  },
  {
    id: "longmemeval-oracle",
    title: "LongMemEval",
    variant: "Oracle",
    repo: "xiaowu0162/longmemeval-cleaned",
    file: /longmemeval_oracle/i,
    about: "The same 500 questions with only the sessions that hold the answer: a cheap check of reasoning without the haystack.",
  },
]);

export const benchOf = (id) => BENCHES.find((bench) => bench.id === id) ?? null;

/** LongMemEval's five abilities, in the paper's order, and the question types each covers. */
export const ABILITIES = Object.freeze([
  { id: "extraction", label: "Information extraction" },
  { id: "multi", label: "Multi-session reasoning" },
  { id: "temporal", label: "Temporal reasoning" },
  { id: "update", label: "Knowledge updates" },
  { id: "abstention", label: "Abstention" },
]);
export const TYPES = Object.freeze(["single-session-user", "single-session-assistant", "single-session-preference", "multi-session", "temporal-reasoning", "knowledge-update"]);

/** A question's ability: an `_abs` question is abstention whatever its type. */
export function abilityOf(id, type) {
  if (/_abs$/.test(String(id ?? ""))) return "abstention";
  if (type === "multi-session") return "multi";
  if (type === "temporal-reasoning") return "temporal";
  if (type === "knowledge-update") return "update";
  return "extraction";
}

// ── The slice ──────────────────────────────────────────────────────────────

/** A dataset item's facts, as a run lists its questions; null without an id. */
export function entryOf(item, i = 0) {
  const id = typeof item?.question_id === "string" ? item.question_id : null;
  if (id === null) return null;
  const type = typeof item.question_type === "string" ? item.question_type : null;
  const text = (v) => (v === null || v === undefined ? null : String(v));
  return { i, id, type, ability: abilityOf(id, type), question: text(item.question), answer: text(item.answer), date: text(item.question_date) };
}

/** FNV-1a: a question's place in every slice, the same on every run. */
export function hashOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * `n` questions, stratified: each type (abstention apart) gets its share of `n` (largest remainder), its questions
 * taken in hash order, and the slice interleaved in hash order. The same `n` is the same slice on every run, and a
 * larger slice holds a smaller one's questions.
 */
export function sliceOf(index, n) {
  const entries = (Array.isArray(index) ? index : []).filter((e) => e && typeof e.id === "string");
  const want = Math.max(0, Math.min(Number.isSafeInteger(n) ? n : entries.length, entries.length));
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.type ?? "?"}${entry.ability === "abstention" ? ":abs" : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const keys = [...groups.keys()].sort();
  const shares = keys.map((key) => {
    const exact = (want * groups.get(key).length) / Math.max(1, entries.length);
    return { key, take: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = want - shares.reduce((sum, s) => sum + s.take, 0);
  for (const share of [...shares].sort((a, b) => b.rest - a.rest || (a.key < b.key ? -1 : 1))) {
    if (left <= 0) break;
    if (share.take < groups.get(share.key).length) {
      share.take += 1;
      left -= 1;
    }
  }
  const picked = [];
  for (const share of shares) picked.push(...[...groups.get(share.key)].sort((a, b) => hashOf(a.id) - hashOf(b.id) || (a.id < b.id ? -1 : 1)).slice(0, share.take));
  return picked.sort((a, b) => hashOf(`slice:${a.id}`) - hashOf(`slice:${b.id}`) || (a.id < b.id ? -1 : 1));
}

// ── Dates ──────────────────────────────────────────────────────────────────

/** "2023/05/20 (Sat) 02:21" as its parts, or null. */
export function parseDate(text) {
  const match = /^\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s*\([A-Za-z]{2,9}\))?(?:\s+(\d{1,2}):(\d{2}))?/.exec(String(text ?? ""));
  if (!match) return null;
  const [y, m, d, h = "12", mi = "00"] = match.slice(1);
  return { y: Number(y), m: Number(m), d: Number(d), h: Number(h), mi: Number(mi) };
}

/** A dataset date as epoch milliseconds, read as UTC (the dataset names no zone), or null. */
export function utcMs(text) {
  const parts = parseDate(text);
  return parts === null ? null : Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.mi);
}

// ── The history ────────────────────────────────────────────────────────────

/**
 * The question's past sessions, oldest first: `{ id, at, turns }`, `at` in epoch milliseconds, each turn
 * `{ role, content }` with its text trimmed. A session with no date, or none of whose turns says anything, is left out.
 */
export function sessionsOf(item) {
  const sessions = Array.isArray(item?.haystack_sessions) ? item.haystack_sessions : [];
  const dates = Array.isArray(item?.haystack_dates) ? item.haystack_dates : [];
  const ids = Array.isArray(item?.haystack_session_ids) ? item.haystack_session_ids : [];
  return sessions
    .map((turns, k) => ({
      k,
      id: typeof ids[k] === "string" ? ids[k] : `session-${k + 1}`,
      at: utcMs(dates[k]),
      turns: (Array.isArray(turns) ? turns : [])
        .map((turn) => ({ role: turn?.role === "assistant" ? "assistant" : "user", content: typeof turn?.content === "string" ? turn.content.trim() : "" }))
        .filter((turn) => turn.content !== ""),
    }))
    .filter((s) => s.at !== null && s.turns.length > 0)
    .sort((a, b) => a.at - b.at || a.k - b.k)
    .map(({ id, at, turns }) => ({ id, at, turns }));
}

/** One session as the transcript a client saves: each turn under who said it, in their own words. */
export function transcriptOf(session) {
  return session.turns.map((turn) => `**${turn.role === "assistant" ? "Assistant" : "User"}:** ${turn.content}`).join("\n\n");
}

// ── Grading: LongMemEval's own prompts (`src/evaluation/evaluate_qa.py`) ────

const CONTAINS = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.";
const TEMPORAL = `${CONTAINS} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.`;
const UPDATE = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.";
const PREFERENCE = "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.";
const ABSTENTION = "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.";

/** The judge's prompt for one question: LongMemEval's template for its type, word for word. */
export function judgePrompt({ id, type, question, answer }, response) {
  const abstention = /_abs$/.test(String(id ?? ""));
  const template = abstention ? ABSTENTION : type === "temporal-reasoning" ? TEMPORAL : type === "knowledge-update" ? UPDATE : type === "single-session-preference" ? PREFERENCE : CONTAINS;
  const label = abstention ? "Explanation" : type === "single-session-preference" ? "Rubric" : "Correct Answer";
  const ask = abstention ? "Does the model correctly identify the question as unanswerable? Answer yes or no only." : "Is the model response correct? Answer yes or no only.";
  return `${template}\n\nQuestion: ${question}\n\n${label}: ${answer}\n\nModel Response: ${response}\n\n${ask}`;
}

/** LongMemEval's rule: correct when the judge's answer contains "yes". */
export const verdictOf = (text) => /yes/i.test(String(text ?? ""));

// ── Cost ───────────────────────────────────────────────────────────────────

/** US dollars per million tokens (`bench/report.mjs`'s table for the models the eval spends on). */
const PRICES = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};
const priceOf = (model) => PRICES[String(model ?? "").replace(/^anthropic\//, "").replace(/^.*\//, "")] ?? null;

/** One call's dollars from its usage (`{ input, output, cacheRead, cacheWrite }`), 0 for a model with no price. */
export function usdOf(model, usage) {
  const price = priceOf(model);
  if (price === null || !usage || typeof usage !== "object") return 0;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return (n(usage.input) * price.input + n(usage.output) * price.output + n(usage.cacheRead) * price.cacheRead + n(usage.cacheWrite) * price.cacheWrite) / 1e6;
}
