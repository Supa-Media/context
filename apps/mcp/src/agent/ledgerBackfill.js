/**
 * A chat with Tex from before its ledger began, a person's own or a group's,
 * copied into the ledger once (decided by the owner, 2026-11-02: "we just need to
 * cobble together everything … just one source of all of this";
 * `docs/decisions/texting-assistant/chat-ledger.md`).
 *
 * Two old copies hold it:
 *
 * 1. The chat's event log in the workspace's store (`log.js`,
 *    `.context/agent/log/<chat>/<id>.json`), every line the person has texted
 *    Tex on: every text both ways, in the Worker's words. Each event keeps its
 *    own id (`eventEntry`), so one already in the ledger is never copied twice.
 * 2. The history record (`history.js`), the gateway's own copy of the newest
 *    exchanges, with the tools each answer used and whether it read from
 *    outside the workspace. What it holds from before the log began is copied
 *    as texts too; and where one of Tex's logged answers is the record's
 *    answer, the record's word for it is kept as a `reply` entry, `clean`
 *    unless the record marked it tainted. That is the only way an old answer
 *    is proven clean (`ledgerHistory.js`): the Worker's event never vouches for
 *    itself, and an answer the record does not hold stays held back.
 *
 * Everything copied goes before what the ledger already holds
 * (`texStore/ledger.js` `prepend`), oldest first, so the chat reads in order.
 * Only what is older than the ledger's oldest entry is copied, so running it
 * again copies nothing. Answers counts only, never a word.
 */

import { eventEntry, ledgerPlace, ONE_TO_ONE_CHAT } from "./ledger.js";
import { EVENT_ID, EVENT_KINDS, LOG_PREFIX, logPrefix } from "./log.js";
import { HISTORY_KEY } from "./history.js";

const READ_BATCH = 25;
const PREPEND_BATCH = 100;
const LIST_PAGES = 1_000;
/** Enough of a text to know two copies are the same answer (as `sentByItself.js`). */
const SAME = 60;
const key = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, SAME);

/** The log's event keys (`<prefix><id>.json`), oldest first, each with the time its id names. */
async function logKeys(store, prefix) {
  const keys = [];
  let cursor;
  for (let page = 0; page < LIST_PAGES; page += 1) {
    const listed = await store.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const object of listed?.objects ?? []) {
      const id = object.key.slice(object.key.lastIndexOf("/") + 1, -".json".length);
      if (object.key.endsWith(".json") && EVENT_ID.test(id)) keys.push({ key: object.key, at: Number(id.slice(0, 13)), id });
    }
    if (!listed?.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return keys.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

async function readEventsAt(store, keys) {
  const events = [];
  for (let at = 0; at < keys.length; at += READ_BATCH) {
    const texts = await Promise.all(keys.slice(at, at + READ_BATCH).map(async ({ key: name }) => {
      const object = await store.get(name);
      return object ? await object.text() : null;
    }));
    for (const text of texts) {
      try {
        const event = text === null ? null : JSON.parse(text);
        if (typeof event?.id === "string" && EVENT_ID.test(event.id) && EVENT_KINDS.has(event.kind) && Number.isSafeInteger(event.at)) events.push(event);
      } catch {
        // Not an event: left out.
      }
    }
  }
  return events.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

async function recordTurns(store) {
  try {
    const object = await store.get(HISTORY_KEY);
    const turns = object === null ? [] : JSON.parse(await object.text())?.turns;
    return Array.isArray(turns) ? turns.filter((turn) => (turn?.role === "user" || turn?.role === "assistant") && typeof turn.text === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The entries the old copies add: the log's events, the record's exchanges
 * from before the log began (`earliest`: these events reach back to the
 * log's start), and the record's word on each logged answer it holds.
 */
export function backfillEntries(events, turns, { before = Number.MAX_SAFE_INTEGER, earliest = true } = {}) {
  const older = events.filter((event) => event.at < before);
  const logStarts = older[0]?.at ?? before;
  const entries = [];
  // The record's answers, by their words, for proving the logged ones.
  const answers = new Map();
  turns.forEach((turn, index) => {
    if (turn.role !== "assistant") return;
    const asked = turns[index - 1];
    answers.set(key(turn.text), { tainted: turn.tainted === true, tools: Array.isArray(turn.tools) ? turn.tools.filter((name) => typeof name === "string") : [], at: asked?.at });
  });
  // What the record holds from before the log began, as texts: a question at its time, the answer just after.
  turns.forEach((turn, index) => {
    if (!earliest || turn.role !== "user" || !Number.isSafeInteger(turn.at) || turn.at >= logStarts || turn.at >= before) return;
    const id = `hist${turn.at}${index}`;
    const eid = (at) => `${String(at).padStart(13, "0")}-${String(index).padStart(6, "0")}`; // an event id, as the log's (`log.js`), so a turn shows it
    entries.push({ v: 1, id: `${id}q`, eid: eid(turn.at), event: "text", at: turn.at, kind: "text", from: { kind: "person" }, text: turn.text, backfill: "record" });
    const answer = turns[index + 1];
    if (answer?.role !== "assistant" || answer.text.trim() === "") return;
    const turnId = `${id}t`;
    for (const name of Array.isArray(answer.tools) ? answer.tools : []) entries.push({ v: 1, id: `${id}u${entries.length}`, at: turn.at + 1, kind: "tool", turn: turnId, name: String(name).slice(0, 64), ok: true, backfill: "record" });
    entries.push({ v: 1, id: `${id}a`, eid: eid(turn.at + 2), event: "text", at: turn.at + 2, kind: "text", from: { kind: "tex" }, text: answer.text, turn: turnId, covers: [eid(turn.at)], delivered: true, backfill: "record" });
    entries.push({ v: 1, id: `${id}r`, at: turn.at + 3, kind: "reply", turn: turnId, clean: answer.tainted !== true, backfill: "record" });
  });
  for (const event of older) {
    entries.push(eventEntry(event));
    const known = event.from?.kind === "tex" && typeof event.turn === "string" ? answers.get(key(event.text)) : undefined;
    if (known === undefined) continue;
    for (const name of known.tools) entries.push({ v: 1, id: `ev${event.id.replace(/\D/g, "")}u${name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40)}`, at: event.at, kind: "tool", turn: event.turn, name: name.slice(0, 64), ok: true, backfill: "record" });
    entries.push({ v: 1, id: `ev${event.id.replace(/\D/g, "")}r`, at: event.at, kind: "reply", turn: event.turn, clean: !known.tainted, backfill: "record" });
  }
  return entries.sort((a, b) => a.at - b.at);
}

/** The entry that says the whole old chat is in, kept first: once it is, nothing is copied again. */
export const BACKFILLED = "backfilledv1";
/** The most log events one run copies: a run is a texted turn's after-work, so it stays well inside the time that has. */
export const BACKFILL_EVENTS = 400;

/**
 * Copy the person's old chat into their ledger, newest first, at most
 * `BACKFILL_EVENTS` of the log a run, until it is all in (`BACKFILLED`, kept
 * first). `{state, entries}`: `none` (no ledger to copy into), `done` (all
 * in already), `would` (a dry run), `copied` (this run added `entries`), `finished`
 * (this run copied the rest).
 */
export async function backfillLedger(store, { dryRun = false, most = BACKFILL_EVENTS, group = null } = {}) {
  const ledger = typeof store?.texLedger === "function" ? store.texLedger(group) : null;
  if (ledger === null || typeof ledger.prepend !== "function") return { state: "none", entries: 0 };
  // A group's log sits in its workspace's store beside other groups', under its own chat's prefix; it has no history record.
  const chat = group ?? ONE_TO_ONE_CHAT;
  const oldest = await ledger.oldest(chat);
  if (oldest?.id === BACKFILLED) return { state: "done", entries: 0 };
  const before = oldest?.at ?? Number.MAX_SAFE_INTEGER;
  const keys = (await logKeys(store, group === null ? LOG_PREFIX : await logPrefix(group))).filter((found) => found.at < before);
  const earliest = keys.length <= most;
  const [events, turns] = await Promise.all([readEventsAt(store, keys.slice(-most)), group === null ? recordTurns(store) : []]);
  const entries = backfillEntries(events, turns, { before, earliest });
  if (dryRun) return { state: "would", entries: entries.length };
  if (earliest) entries.unshift({ v: 1, id: BACKFILLED, at: Math.max(1, Math.min(before, ...entries.map((entry) => entry.at)) - 1), kind: "note", text: "(The chat before this ledger began was copied in here.)", backfill: "mark" });
  // Newest batch first, each placed before the last, so the whole reads oldest first.
  let added = 0;
  for (let end = entries.length; end > 0; end -= PREPEND_BATCH) added += (await ledger.prepend(chat, entries.slice(Math.max(0, end - PREPEND_BATCH), end))).added;
  return { state: earliest ? "finished" : "copied", entries: added };
}

/** Chats (workspace and chat) whose old chat is all in, as this isolate has seen: they are never asked again. */
const finished = new Set();

/**
 * Run a backfill part after the answer of a request that wrote a chat
 * (`textingRoutes.js` `handleEvents`): a person's own chat, or a group's,
 * whose log sits in its workspace's store. Never on a texted turn's own way to
 * its model. Logs its outcome by count only.
 */
export function startBackfill(store, session) {
  const workspace = String(session?.workspaceId ?? "");
  const place = ledgerPlace(session);
  const group = place?.owner?.chat ?? null;
  const done = `${workspace}:${group ?? ONE_TO_ONE_CHAT}`;
  if (workspace === "" || place === null || finished.has(done) || typeof store?.defer !== "function") return;
  store.defer(async () => {
    try {
      const run = await backfillLedger(store, { group });
      if (run.state === "done" || run.state === "finished" || run.state === "none") finished.add(done);
      if (run.state !== "done") console.log(JSON.stringify({ event: "tex_ledger_backfill", workspace_id: workspace, group: group !== null, state: run.state, entries: run.entries }));
    } catch (error) {
      console.log(JSON.stringify({ event: "tex_ledger_backfill_failed", workspace_id: workspace, group: group !== null, reason: String(error?.name ?? "error").slice(0, 40) }));
    }
  });
}
