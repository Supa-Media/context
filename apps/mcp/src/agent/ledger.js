/**
 * THE CHAT'S LEDGER, GATEWAY SIDE: what an entry says, what is left out of it,
 * and the writer every part of a turn calls (decided by the owner, 2026-11-02;
 * `docs/decisions/texting-assistant/chat-ledger.md`). The object keeps the
 * rows (`texStore/ledger.js`); this decides their words.
 *
 * Everything is kept: what they sent, what Tex sent, its thinking, the words
 * between its tools, each tool call with its arguments, outcome, time and
 * result, the advisor's asks, the Mail checker's verdicts, jobs. One thing is
 * left out, by the owner's rule: a call that read from another workspace keeps
 * what it asked for and how it went, never what came back
 * (`withheld: "other_workspace"`), because the ledger lives with this chat and
 * the other workspace's notes are not this chat's to keep. Arguments named
 * like a secret are kept as `[hidden]`; saved logins never reach a turn at all
 * (`vault.md`).
 *
 * Entry fields, schema `tex-ledger` v1 (every entry `{v, id, at, kind, seq}`,
 * `turn` when a turn wrote it):
 * - `text`: `{from: {kind: "person"|"tex"|"system", name?, who?}, text, covers?, delivered?, reason?, told?, replyTo?, event?}`
 * - `thinking`: `{text, ms?, output?}`, the model's thinking in words, as it came back, with its model round's milliseconds and output tokens
 * - `said`: `{text}`, what the model said between its tools
 * - `tool`: `{name, args, as?, ok, ms, held?, reason?, result?, cut?, withheld?}`; `as` is `{name, args}` as the model wrote the call, when that differs; `grant` is the grant id the call ran under, which a later text replays its result only under (`stretch.js`)
 * - `reply`: `{text, ms, model?, timing?}`, the turn's answer as it left the gateway; `timing` is where its time went (`turnTiming.js`)
 * - `advisor`: `{question, answer, ms, steps?}` / `mail_check`: `{to, subject, verdict, why, ref?}` / `job`: `{job, title?, state}`
 * - `note`: `{text}`, anything else worth keeping (a routine's text, a check-in)
 * - `judge`: `{text, by, model?, round, went, ms?, notice?, reason?, judges: [{id, yes, at, passed}], failed}`, one judging of a draft reply (`replyJudge.js`; `by` is `review` for the Haiku reviewer since 2026-11-06, with `turnKind` and the problems it named in `failed`, or `gates` before): `text` is the draft, `went` whether it went out
 * - `day`: `{day, text, model?}`, one finished day summed up the night after (`daySummaries.js`), id `day-<YYYY-MM-DD>` so a day keeps one; `at` is that day's last entry
 */

import { gatewayTexStore } from "../texStore/wire.js";

/** A tool result longer than this is kept cut, with its full length in `cut`. */
export const MAX_RESULT_CHARS = 64_000;
/** Words longer than this (a pasted essay) are kept cut the same way. */
export const MAX_WORDS_CHARS = 32_000;

const SECRET_KEY = /pass|secret|token|otp|pin\b|cvv|card|api[-_]?key|credential|^code$/i;
const MAX_ARG_DEPTH = 6;

const newId = () => crypto.randomUUID().replace(/-/g, "");

function cutText(value, max) {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return text.length > max ? { text: text.slice(0, max), cut: text.length } : { text };
}

/** A tool's arguments as kept: whole, apart from a value named like a secret. */
export function keptArgs(value, key = null, depth = 0) {
  if (typeof key === "string" && SECRET_KEY.test(key) && value !== null && value !== undefined && value !== "") return "[hidden]";
  if (depth > MAX_ARG_DEPTH) return "[deeper]";
  if (Array.isArray(value)) return value.map((item) => keptArgs(item, null, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keptArgs(v, k, depth + 1)]));
  if (typeof value === "string") return value.length > MAX_WORDS_CHARS ? `${value.slice(0, MAX_WORDS_CHARS)}… [cut, ${value.length} characters]` : value;
  return value;
}

/** The workspace a call named, as a handle without its `@`, or null when it named none (the turn's own). */
function namedContext(args) {
  const named = args && typeof args === "object" ? args.context : undefined;
  if (typeof named !== "string" || named.trim() === "") return null;
  return named.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Whether a call read from a workspace other than the one this chat's turns
 * run in (`session.workspaceSlug`): its result is then never kept.
 */
export function readsOtherWorkspace(args, ownSlug) {
  const named = namedContext(args);
  if (named === null) return false;
  return typeof ownSlug !== "string" || named !== ownSlug.toLowerCase();
}

/** A tool call's entry. `result` is the text the model was shown. */
export function toolEntry({ name, args, as = null, ok, ms, held = false, reason = null, result = null, thinking = null }, { ownSlug, turn = null, grant = null, at = Date.now() } = {}) {
  const entry = { v: 1, id: newId(), at, kind: "tool", ...(turn ? { turn } : {}), ...(typeof grant === "string" && grant !== "" ? { grant: grant.slice(0, 80) } : {}), name: String(name ?? "").slice(0, 64), args: keptArgs(args ?? {}), ok: ok === true, ms: Number.isFinite(ms) ? Math.round(ms) : 0 };
  if (held) entry.held = true;
  // The name and arguments the model wrote, when it called one of the six (`sixTools.js`): what a later text replays (`stretch.js`).
  if (as && typeof as.name === "string" && as.name !== entry.name) entry.as = { name: as.name.slice(0, 64), args: keptArgs(as.args ?? {}) };
  if (typeof reason === "string" && reason !== "") entry.reason = reason.slice(0, 400);
  if (readsOtherWorkspace(args, ownSlug)) entry.withheld = "other_workspace";
  else if (typeof result === "string") {
    const kept = cutText(result, MAX_RESULT_CHARS);
    entry.result = kept.text;
    if (kept.cut !== undefined) entry.cut = kept.cut;
  }
  // The advisor's thinking, beside its answer (`advisor.js`): what the tool thought, never Tex's own.
  if (typeof thinking === "string" && thinking.trim() !== "" && entry.withheld === undefined) entry.thinking = cutText(thinking, MAX_WORDS_CHARS).text;
  return entry;
}

/** An entry of words (`thinking`, `said`, `reply`, `note`), cut when very long. */
export function wordsEntry(kind, text, { turn = null, at = Date.now(), ...extra } = {}) {
  const kept = cutText(text, MAX_WORDS_CHARS);
  return { v: 1, id: newId(), at, kind, ...(turn ? { turn } : {}), ...extra, text: kept.text, ...(kept.cut !== undefined ? { cut: kept.cut } : {}) };
}

/** A chat event (`log.js` shape) as a `text` entry; its id is the event's, so the same event is kept once. */
export function eventEntry(event) {
  const { id, at, chat: _chat, kind: eventKind, text, ...rest } = event ?? {};
  const kept = cutText(text ?? "", MAX_WORDS_CHARS);
  return { v: 1, id: `ev${String(id).replace(/[^0-9A-Za-z]/g, "")}`, eid: id, at, kind: "text", event: eventKind, ...rest, text: kept.text, ...(kept.cut !== undefined ? { cut: kept.cut } : {}) };
}

/**
 * The ledgers in one owner's Tex object (`{person: workspaceId}` or `{chat:
 * groupKey}`, as `ledgerPlace` names it), or null without the
 * binding: `{append(chat, entries), read(chat, options), chats()}`.
 */
export function ledgerFor(env, owner) {
  const name = owner?.person ? `person:${owner.person}` : owner?.chat ? `chat:${owner.chat}` : null;
  if (name === null) return null;
  const store = gatewayTexStore(env)(name);
  return store?.ledger ?? null;
}

/**
 * A writer for one chat that never throws and keeps the order it was given:
 * `write(entries)` queues them, `flush()` waits for every write so far. A
 * write that failed is logged by count and kind, never its words.
 */
export function ledgerWriter(ledger, chat) {
  if (ledger === null || typeof chat !== "string" || chat === "") return null;
  let chain = Promise.resolve();
  const write = (entries) => {
    const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if (list.length === 0) return chain;
    chain = chain.then(async () => {
      for (let at = 0; at < list.length; at += 100) {
        try {
          await ledger.append(chat, list.slice(at, at + 100));
        } catch (error) {
          console.log(JSON.stringify({ event: "ledger_write_failed", count: list.length, kinds: [...new Set(list.map((entry) => entry.kind))], reason: String(error?.name ?? "error").slice(0, 40) }));
        }
      }
    });
    return chain;
  };
  return { write, flush: () => chain };
}

const GROUP_KEY = /^[0-9a-f]{64}$/;
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
/** The entry that says a person's whole old chat is copied in, kept first: once it is, nothing is copied again (`ledgerBackfill.js`). */
export const BACKFILLED = "backfilledv1";
/** A person's one-to-one chat with Tex is one ledger, whichever line they text on, as their history record is. */
export const ONE_TO_ONE_CHAT = "texts";

/**
 * Whose ledger a session's turn writes and under which chat: a group's when
 * the grant names one (`chat:<groupKey>`, chat = the group key), the person's
 * own one-to-one chat on their personal workspace (`person:<workspaceId>`,
 * chat `texts`), otherwise none.
 */
export function ledgerPlace(session) {
  if (typeof session?.texChatId === "string" && GROUP_KEY.test(session.texChatId)) return { owner: { chat: session.texChatId }, chat: session.texChatId };
  // A group grant that names no chat keeps none: never the person's own one-to-one ledger, which a group's words must not reach.
  if (session?.actorClientId === TEXTS_GROUP_CLIENT_ID) return null;
  if (session?.workspaceKind === "personal" && typeof session.workspaceId === "string" && session.workspaceId !== "") return { owner: { person: session.workspaceId }, chat: ONE_TO_ONE_CHAT };
  return null;
}

/** The never-throwing writer for a session's chat (`ledgerWriter`), or null when it keeps none. */
export function sessionLedger(env, session) {
  const place = ledgerPlace(session);
  if (place === null) return null;
  return ledgerWriter(ledgerFor(env, place.owner), place.chat);
}

/**
 * The writer for the ledger of the chat a session's turn is in, through the
 * turn's own store (`store/texRouting.js` `texLedger`), or null when the
 * session keeps none (the app, a shared workspace's own connection).
 */
export function storeLedger(store, session) {
  const place = ledgerPlace(session);
  if (place === null || typeof store?.texLedger !== "function") return null;
  return ledgerWriter(store.texLedger(place.owner.chat ?? null), place.chat);
}

/**
 * A writer that marks every entry with the background job whose turn wrote it
 * (`jobId`, `jobTitle`), so the chat's one record says which work was a job's
 * (the owner, 2026-11-02: sub-agent work "in the chat's history, tagged").
 * `job` entries keep their own `job` field; this never replaces it.
 */
export function jobTagged(writer, job) {
  if (writer === null || !job || typeof job.id !== "string") return writer;
  const tag = { jobId: job.id, ...(typeof job.title === "string" && job.title ? { jobTitle: job.title } : {}) };
  return {
    ...writer,
    write: (entries) => writer.write((Array.isArray(entries) ? entries : [entries]).filter(Boolean).map((entry) => ({ ...entry, ...tag }))),
    flush: () => writer.flush(),
  };
}

/** The model round a thinking entry came from: its milliseconds and output tokens, numbers only (`turn.js`). */
function roundCost(event) {
  const cost = {};
  if (Number.isFinite(event.ms) && event.ms >= 0) cost.ms = Math.round(event.ms);
  if (Number.isFinite(event.output) && event.output >= 0) cost.output = Math.round(event.output);
  return cost;
}

/**
 * A turn's steps (`turn.js` `tell`) written to its chat's ledger, beside
 * whatever else watches them (`then`): thinking, the words between tools, and
 * every tool call with its result.
 */
export function ledgerObserver(writer, then = null, { turn = null, ownSlug = null, grant = null } = {}) {
  if (writer === null) return then;
  const at = { turn: typeof turn === "string" && turn !== "" ? turn : null };
  return (event) => {
    if (typeof then === "function") then(event);
    if (event?.kind === "thinking" && typeof event.text === "string" && event.text.trim() !== "") writer.write(wordsEntry("thinking", event.text, { ...at, ...roundCost(event) }));
    else if (event?.kind === "say" && typeof event.text === "string" && event.text.trim() !== "") writer.write(wordsEntry("said", event.text, at));
    else if (event?.kind === "tool") writer.write(toolEntry(event, { ownSlug, turn: at.turn, grant }));
    else if (event?.kind === "judge") writer.write(judgeEntry(event, at));
  };
}

/** A judging of a draft reply (`replyJudge.js` `judgeEvent`) as a `judge` entry: names, numbers and the draft, cut like any words. */
export function judgeEntry(event, at = {}) {
  const judges = (Array.isArray(event.judges) ? event.judges : []).map((judge) => ({ id: String(judge.id), yes: typeof judge.yes === "number" && Number.isFinite(judge.yes) ? judge.yes : null, at: typeof judge.at === "number" ? judge.at : null, passed: judge.passed === true }));
  return wordsEntry("judge", event.draft ?? "", {
    ...at,
    by: JUDGE_BY.has(event.by) ? event.by : "gates",
    ...(typeof event.model === "string" ? { model: event.model } : {}),
    round: Number.isSafeInteger(event.round) ? event.round : 0,
    went: event.went === true,
    ...(Number.isFinite(event.ms) ? { ms: Math.round(event.ms) } : {}),
    ...(typeof event.notice === "string" && event.notice ? { notice: cutText(event.notice, MAX_WORDS_CHARS).text } : {}),
    ...(typeof event.reason === "string" && event.reason ? { reason: event.reason } : {}),
    ...(typeof event.turnKind === "string" && event.turnKind ? { turnKind: event.turnKind.slice(0, 20) } : {}),
    judges,
    // The gates' failed ids, or the reviewer's problem names (`replyJudge.js` `PROBLEMS`).
    failed: judges.length > 0 ? judges.filter((judge) => !judge.passed).map((judge) => judge.id) : (Array.isArray(event.failed) ? event.failed : []).filter((id) => typeof id === "string").map((id) => id.slice(0, 40)).slice(0, 12),
  });
}

/** Who judged a draft: the reviewer, the code checks, a late text, or the gates (before 2026-11-06). */
const JUDGE_BY = new Set(["review", "code", "late", "gates"]);
