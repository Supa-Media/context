/**
 * Decide and the last look, asked of Clef here in the gateway (Dev2's pick, 2026-11-05: decide moves into the
 * gateway, its daily cap and usage rows kept). The texting Worker asks over the `TexTexts` service binding (no public
 * URL, no secret of its own), with the body it used to send the control plane's `/agent-texts/decide` and
 * `/agent-texts/recheck`. The questions and how answers read are the control plane's own copy
 * (`packages/shared/src/textDecide.cjs`), so the two never drift.
 *
 * The cap and the usage rows stay in the control plane: the Worker asks its gate now and then and reports what was
 * decided after the answer is in (`apps/agent/src/decide.ts`). So this answers with `meter`, the counts that report
 * needs: questions asked and characters Clef read, never words.
 *
 * The transcript and the draft are answered on, never kept or logged here: the one log line carries counts and codes.
 * The judge's verdict on a group's moment is kept in that chat's ledger as a `judge` entry (`judgeVerdictEntry`), when
 * the Worker names the chat's ledger key: what it chose, the why, the event it judged, never a word of the chat.
 */

import { DECISION_MODEL, decisionEngine } from "./decide.js";
import { ledgerFor, ledgerWriter } from "./ledger.js";
import { dayFromLedger } from "./ledgerHistory.js";
import { foldThreads, THREADS_SUFFIX } from "./threadsFold.js";
import { decideRequest, readDecideAnswers, readDecideBody, readRecheckAnswers, readRecheckBody, recheckRequest } from "../../../../packages/shared/src/textDecide.cjs";

/** The paths the Worker posts to on the `TexTexts` binding. */
export const TEXTS_DECIDE_PATH = "/texts/decide";
export const TEXTS_RECHECK_PATH = "/texts/recheck";
/** The chat's last day from its ledger, for a judge whose Worker holds no token for the chat (`chatRead.ts`). */
export const TEXTS_CHAT_PATH = "/texts/chat";
const LEDGER_KEY = /^[0-9a-f]{64}$/;
const GROUP_ID = /^[A-Za-z0-9._:@+=-]{1,256}$/;
const CHAT_DAY_MS = 24 * 60 * 60 * 1000;
const CHAT_READ = 2_000;
/** A transcript, a draft, 32 ids and 8 asks, with room for the JSON around them. */
const MAX_BODY_CHARS = 64_000;

async function readJson(request) {
  if (request.method !== "POST") return null;
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    const body = JSON.parse(text);
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * `{ ...decide's answer, meter: { questions, chars, ms } }`; a model that fails or answers off the set is
 * `{ ok: false, reason: "unavailable", cause }`, as the control plane answered it. `engine` is for tests.
 */
export async function decideForTexts(request, env, { engine = decisionEngine(env?.AI), ledger = (key) => ledgerFor(env, { chat: key }), waitUntil = null } = {}) {
  const path = new URL(request.url).pathname;
  const recheck = path === TEXTS_RECHECK_PATH;
  const raw = await readJson(request);
  const body = raw === null ? null : recheck ? readRecheckBody(raw) : readDecideBody(raw);
  if (body === null) return new Response(null, { status: 400 });
  // No model here (a gateway with no AI binding): 503, so the Worker asks the control plane as it did before.
  if (engine === null) return new Response(null, { status: 503 });
  // What Tex is doing in this chat right now, from its ledger: facts the judge reads beside the chat (Dev2, 2026-11-12).
  const facts = recheck || !body.ledger ? [] : await nowFacts(ledger(body.ledger), body.ledger);
  const asked = recheck ? recheckRequest(body) : decideRequest(body, { facts });
  const meter = { questions: Object.keys(asked.questions).length, chars: asked.state.length + JSON.stringify(asked.questions).length, ms: 0 };
  const started = Date.now();
  const answers = await engine(asked.state, asked.questions);
  meter.ms = Date.now() - started;
  const result =
    answers === null
      ? { ok: false, reason: "unavailable", cause: "model_failed" }
      : recheck
        ? readRecheckAnswers(answers)
        : readDecideAnswers(body, answers);
  // Counts and codes only: never the transcript, a draft, or a number.
  console.log(
    JSON.stringify({
      event: recheck ? "texts_recheck_gateway" : "texts_decide_gateway",
      style: body.style,
      candidates: body.candidates.length,
      ms: meter.ms,
      ...(result.ok ? (recheck ? { fits: result.fits } : { act: result.act, covers: result.covers.length }) : { cause: result.cause }),
    }),
  );
  // The verdict in the group's ledger, behind the answer: never on the text's path.
  if (!recheck && result.ok && body.ledger) {
    const written = ledgerWriter(ledger(body.ledger), body.ledger)?.write(judgeVerdictEntry(body, result, meter.ms)) ?? Promise.resolve();
    if (typeof waitUntil === "function") waitUntil(written);
  }
  return Response.json({ ...result, meter: { ...meter, answered: answers !== null } });
}

/** The verdict words the design names (`one-judge-one-record.md`) for the contract's acts. */
const VERDICT = { answer: "respond", react: "react", silent: "quiet", wait: "wait" };

/**
 * One judging of a moment as a `judge` entry (`agent/ledger.js`): `by: "moment"`, the verdict, its why (one of the
 * judge's labels), the event judged, and when a turn ran, what that text does to it. Names and codes only.
 */
export function judgeVerdictEntry(body, result, ms) {
  return {
    v: 1,
    id: `judge${body.newest.replace(/[^0-9]/g, "")}${body.running ? "r" : ""}${Date.now().toString(36)}`,
    at: Date.now(),
    kind: "judge",
    by: "moment",
    model: DECISION_MODEL,
    verdict: VERDICT[result.act],
    went: result.act === "answer",
    event: body.newest,
    ...(result.why ? { why: result.why } : {}),
    ...(result.emoji ? { emoji: result.emoji } : {}),
    ...(result.midTurn ? { midTurn: result.midTurn } : {}),
    confidence: result.confidence,
    ms,
  };
}

/**
 * `POST /texts/chat` on the binding: `{ ledger, chat }`, the group's ledger key and its chat id, answered with the
 * chat's last day as events, the same day `/agent/chat` answers a Worker holding the chat's token. Before this a
 * Worker that had just woken held no token, so the judge read only the texts it had not posted yet: 34 of 53 reads
 * on 2026-11-10 to 11-12 (`tex_chat_read` `no_token`), the judge blind to the question a tapback answered. Reached
 * only over the service binding, as decide's own ledger write is; never logged with words. `ledger` is for tests.
 */
export async function chatForTexts(request, env, { ledger = (key) => ledgerFor(env, { chat: key }), now = Date.now() } = {}) {
  const body = await readJson(request);
  const key = typeof body?.ledger === "string" && LEDGER_KEY.test(body.ledger) ? body.ledger : null;
  const chat = typeof body?.chat === "string" && GROUP_ID.test(body.chat) ? body.chat : null;
  if (key === null || chat === null) return new Response(null, { status: 400 });
  const store = ledger(key);
  if (store === null) return Response.json({ events: [] });
  try {
    const read = await store.read(key, { before: Number.MAX_SAFE_INTEGER, kinds: ["text"], limit: CHAT_READ, since: now - CHAT_DAY_MS });
    const events = dayFromLedger(read?.entries ?? [], chat, []) ?? [];
    console.log(JSON.stringify({ event: "texts_chat_gateway", events: events.length }));
    return Response.json({ events });
  } catch {
    console.log(JSON.stringify({ event: "texts_chat_gateway", outcome: "failed" }));
    return new Response(null, { status: 503 });
  }
}

/** The longest the judge waits on the ledger for its facts: they help it, and are never worth a slower answer. */
const FACTS_MS = 400;
/** A job not heard from in this long is not shown as running. */
const JOB_FRESH_MS = 6 * 60 * 60 * 1000;
const RUNNING = new Set(["started", "keep_going"]);

/**
 * Facts for the judge from the chat's ledger, each one line: the jobs Tex is running here, by title and start time.
 * Read within `FACTS_MS`; none when the ledger is slow or can't be read. Titles only, never a word of the chat.
 */
export async function nowFacts(store, key, { now = Date.now(), timeoutMs = FACTS_MS } = {}) {
  if (store === null || typeof store?.read !== "function") return [];
  const within = (read) => Promise.race([read.catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
  // Both reads at once, from the same object, under the one wait.
  const [result, threaded] = await Promise.all([
    within(Promise.resolve().then(() => store.read(key, { before: Number.MAX_SAFE_INTEGER, kinds: ["job"], limit: 200, since: now - JOB_FRESH_MS }))),
    within(Promise.resolve().then(() => store.read(`${key}${THREADS_SUFFIX}`, { before: Number.MAX_SAFE_INTEGER, kinds: ["thread"], limit: 200, since: now - THREAD_FRESH_MS }))),
  ]);
  return [...jobFacts(Array.isArray(result?.entries) ? result.entries : []), ...threadFacts(Array.isArray(threaded?.entries) ? threaded.entries : [])];
}

/** The conversation threads the classifier keeps for this chat that are open, newest first: a title and its newest lines' ids. */
const THREAD_FRESH_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_THREADS = 6;
function threadFacts(entries) {
  const open = foldThreads(entries).threads.filter((thread) => thread.status === "open" && thread.title !== "").sort((a, b) => b.last - a.last).slice(0, MAX_THREADS);
  return open.map((thread) => `Open conversation "${thread.title.replace(/["\n]/g, " ")}", its newest lines ${thread.texts.slice(-2).map((id) => `<${id}>`).join(" ")}.`);
}

function jobFacts(entries) {
  // Newest first: a job's first entry seen is its latest state; its start is its oldest.
  const latest = new Map();
  const startedAt = new Map();
  // A job's title is on whichever of its entries carries one (a keep-going entry often has none).
  const titles = new Map();
  for (const entry of entries) {
    if (entry?.kind !== "job" || typeof entry.job !== "string") continue;
    if (!latest.has(entry.job)) latest.set(entry.job, entry);
    if (entry.state === "started") startedAt.set(entry.job, entry.at);
    if (typeof entry.title === "string" && !titles.has(entry.job)) titles.set(entry.job, entry.title);
  }
  const at = (ms) => new Date(ms).toISOString().slice(11, 16);
  return [...latest.values()]
    .filter((entry) => RUNNING.has(entry.state))
    .slice(0, 4)
    .map((entry) => `Tex is working on a job in this chat: "${String(titles.get(entry.job) ?? "untitled").replace(/["\n]/g, " ").slice(0, 120)}"${startedAt.has(entry.job) ? `, started ${at(startedAt.get(entry.job))} UTC` : ""}.`);
}
