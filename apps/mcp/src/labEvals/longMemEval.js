/**
 * LONGMEMEVAL, RUN THROUGH REAL TEX (Dev2, 2026-11-20: "create an evals tab one of them being the LongMemEval, and
 * build out the adapter for this eval"; decision `docs/decisions/texting-assistant/lab-evals.md`).
 *
 * LongMemEval (Wu et al., ICLR 2025, github.com/xiaowu0162/LongMemEval, MIT) is 500 questions, each with a long
 * history of past chats between a user and an assistant and one question about it. This file is the adapter's pure
 * half, everything that needs no network and no object:
 *
 *  - `BENCHES`: the variants the Lab offers, each a file of the dataset on Hugging Face;
 *  - `createScanner`: finds each question's bytes in the dataset's one big JSON array as it streams past, so one
 *    question is later fetched alone with a range request (the S file is about 280 MB, far past a Worker's memory);
 *  - `sliceOf`: the same stratified slice of n questions every time, so two runs of one size compare;
 *  - `historyOf`: the question's past sessions as a test chat's history: the person's turns as their texts, the
 *    assistant's as Tex's, each session on its own date, every date moved by whole days so the question is asked
 *    today (Tex only knows the real now) and the 7-day window, day summaries and day reads work as in production;
 *  - `judgePrompt` and `verdictOf`: LongMemEval's own grading prompts (its `evaluate_qa.py`), one per question type,
 *    and its rule (the judge's answer contains "yes").
 */

import { eventId } from "../labSandbox/harness.js";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

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

// ── Finding each question in the dataset ───────────────────────────────────

/** How much of each question's start is kept while scanning: its id, type, question and answer come first. */
export const HEAD_BYTES = 6_000;

/**
 * A scanner over the bytes of a JSON array of objects, fed in chunks: each top-level object's first and last byte
 * offset and its first `HEAD_BYTES` bytes. Strings and escapes are followed, so a brace inside a text never counts.
 * UTF-8's multi-byte characters never hold an ASCII byte, so bytes are scanned as they come.
 */
export function createScanner({ headBytes = HEAD_BYTES } = {}) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let offset = 0;
  let start = -1;
  let head = null;
  let headLength = 0;
  const found = [];
  return {
    found,
    push(bytes) {
      for (let i = 0; i < bytes.length; i += 1) {
        const b = bytes[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (b === 92) escaped = true;
          else if (b === 34) inString = false;
        } else if (b === 34) {
          inString = true;
        } else if (b === 123 || b === 91) {
          if (b === 123 && depth === 1) {
            start = offset + i;
            head = new Uint8Array(headBytes);
            headLength = 0;
          }
          depth += 1;
        } else if (b === 125 || b === 93) {
          depth -= 1;
          if (b === 125 && depth === 1 && start >= 0) {
            found.push({ start, end: offset + i, head: head.subarray(0, headLength) });
            start = -1;
            head = null;
          }
        }
        if (start >= 0 && headLength < headBytes) head[headLength++] = b;
      }
      offset += bytes.length;
    },
  };
}

const fieldPattern = (key) => new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|-?[0-9][0-9.eE+-]*)`);
const FIELDS = { id: fieldPattern("question_id"), type: fieldPattern("question_type"), question: fieldPattern("question"), answer: fieldPattern("answer"), date: fieldPattern("question_date") };

function fieldOf(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return value === null || value === undefined ? null : String(value);
  } catch {
    return null;
  }
}

const cut = (text, most) => (typeof text === "string" && text.length > most ? `${text.slice(0, most - 1)}…` : text);

/** One scanned question as the index keeps it: where its bytes are, and what its start says. Null without an id. */
export function indexEntry(found, i) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(found.head);
  const id = fieldOf(text, FIELDS.id);
  if (id === null) return null;
  const type = fieldOf(text, FIELDS.type);
  return { i, id, type, ability: abilityOf(id, type), start: found.start, end: found.end, question: cut(fieldOf(text, FIELDS.question), 400), answer: cut(fieldOf(text, FIELDS.answer), 400), date: fieldOf(text, FIELDS.date) };
}

// ── The slice ──────────────────────────────────────────────────────────────

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

/** How far `timeZone`'s wall clock is ahead of UTC at `ms`; 0 for an unknown zone. */
function offsetMs(ms, timeZone) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(new Date(ms))
        .map((part) => [part.type, part.value]),
    );
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)) - Math.floor(ms / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** A wall-clock time in `timeZone` as epoch milliseconds. */
export function zonedMs({ y, m, d, h, mi }, timeZone) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = offsetMs(guess, timeZone);
  const second = offsetMs(guess - first, timeZone);
  return guess - second;
}

// ── The history ────────────────────────────────────────────────────────────

/** The most one past turn holds in the test chat (a Tex text up to the sandbox's own row limit). */
const MAX_TURN_CHARS = 20_000;

/**
 * The question's past sessions as a test chat's start (`labSandbox/route.js` `open` source "eval"): `rows` as the Lab
 * shows them, `history` as the ledger keeps texts, both oldest first. Each session starts at its own date in the
 * person's time zone, its turns a minute apart; every date is moved by the same whole number of days (`shiftDays`) so
 * the question's date is today, and none lands after `now`.
 */
export function historyOf(item, { now = Date.now(), timeZone = "UTC" } = {}) {
  const sessions = Array.isArray(item?.haystack_sessions) ? item.haystack_sessions : [];
  const dates = Array.isArray(item?.haystack_dates) ? item.haystack_dates : [];
  const ids = Array.isArray(item?.haystack_session_ids) ? item.haystack_session_ids : [];
  const dated = sessions
    .map((turns, k) => ({ k, turns: Array.isArray(turns) ? turns : [], parts: parseDate(dates[k]), id: ids[k] ?? null }))
    .filter((s) => s.parts !== null)
    .map((s) => ({ ...s, ms: zonedMs(s.parts, timeZone) }))
    .sort((a, b) => a.ms - b.ms || a.k - b.k);
  const lastSession = dated.at(-1);
  const asked = parseDate(item?.question_date);
  const askedMs = asked !== null ? zonedMs(asked, timeZone) : (lastSession?.ms ?? now) + DAY_MS;
  let shiftDays = Math.floor((now - askedMs) / DAY_MS);
  const lastAt = (shift) => Math.max(...dated.map((s) => s.ms + shift * DAY_MS + Math.max(0, s.turns.length - 1) * MINUTE_MS), -Infinity);
  while (dated.length > 0 && lastAt(shiftDays) >= now - MINUTE_MS) shiftDays -= 1;
  const rows = [];
  const history = [];
  let previous = -Infinity;
  let turns = 0;
  for (const session of dated) {
    session.turns.forEach((turn, j) => {
      const text = typeof turn?.content === "string" ? turn.content.trim() : "";
      if (text === "") return;
      let at = session.ms + shiftDays * DAY_MS + j * MINUTE_MS;
      if (at <= previous) at = previous + 1_000;
      previous = at;
      const eid = eventId(at);
      const tex = turn.role === "assistant";
      const said = text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS - 1)}…` : text;
      rows.push({ id: eid, eid, who: tex ? "Tex" : "You", text: said, at, prod: true });
      history.push(
        tex
          ? { v: 1, id: `ev${eid.replace("-", "")}`, eid, at, kind: "text", event: "text", from: { kind: "tex" }, text: said, delivered: true }
          : { v: 1, id: `ev${eid.replace("-", "")}`, eid, at, kind: "text", event: "text", from: { kind: "person" }, text: said },
      );
      turns += 1;
    });
  }
  const days = new Set(history.map((entry) => new Date(entry.at + offsetMs(entry.at, timeZone)).toISOString().slice(0, 10))).size;
  return { rows, history, shiftDays, sessions: dated.length, turns, days, askedAt: askedMs + shiftDays * DAY_MS };
}

// ── Grading: LongMemEval's own prompts (`src/evaluation/evaluate_qa.py`) ────

const CONTAINS = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.";
const TEMPORAL = `${CONTAINS} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.`;
const UPDATE = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.";
const PREFERENCE = "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.";
const ABSTENTION = "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.";

/** A date in the answer, which the move to today shifts: a month's name, or digits like 5/20 or 2023-05-20. */
const NAMES_A_DATE = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{1,4}[/-]\d{1,2}([/-]\d{1,4})?\b/i;

/**
 * The judge's prompt for one question: LongMemEval's template for its type, word for word. One line is added only when
 * the history was moved and the correct answer names a date or weekday: the history Tex read is dated `shiftDays` later.
 */
export function judgePrompt({ id, type, question, answer }, response, shiftDays = 0) {
  const abstention = /_abs$/.test(String(id ?? ""));
  const template = abstention ? ABSTENTION : type === "temporal-reasoning" ? TEMPORAL : type === "knowledge-update" ? UPDATE : type === "single-session-preference" ? PREFERENCE : CONTAINS;
  const label = abstention ? "Explanation" : type === "single-session-preference" ? "Rubric" : "Correct Answer";
  const ask = abstention ? "Does the model correctly identify the question as unanswerable? Answer yes or no only." : "Is the model response correct? Answer yes or no only.";
  const moved =
    shiftDays !== 0 && NAMES_A_DATE.test(String(answer ?? ""))
      ? `\n\nNote: the conversation history the model read was moved ${Math.abs(shiftDays)} days ${shiftDays > 0 ? "later" : "earlier"} than the original, so a date or weekday that is the correct answer's moved by exactly that many days counts as the same.`
      : "";
  return `${template}${moved}\n\nQuestion: ${question}\n\n${label}: ${answer}\n\nModel Response: ${response}\n\n${ask}`;
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

/** A step's dollars as the test chat logged it: its own `cost`, else its tokens at its model's price. */
export function stepUsd(step) {
  if (Number.isFinite(step?.cost)) return step.cost;
  return usdOf(step?.model, { input: step?.tokIn, output: step?.tokOut });
}
