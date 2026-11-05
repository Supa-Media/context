/**
 * What a texted turn is shown of its chat.
 *
 * Today's history (`conversation.js`, a group's memory in `groupTurn.js`) is
 * still read and still written by every turn, so reverting the event log
 * loses nothing. When the Worker names the inbound events a turn answers
 * (`covers`, docs/design/tex-event-log/CONTRACT.md) and its `chat`, and that
 * chat's log (`log.js`) holds all of them, the model is shown the rendered log
 * (`logRender.js`) as its conversation instead, and asked the covered events'
 * words. Every guard (the browser's addresses, the Mail checker, the sharing
 * judge, a texted yes) still reads the request's `question` and today's
 * history, never this. An old chat with no log, or a request naming events
 * not yet logged, is today's turn.
 *
 * Trust is the turn's own (the owner, 2026-11-05): a turn that reads from
 * outside the workspace is untrusted for what it sends, and nothing it said
 * marks a later turn. Every earlier answer is shown as it was said, one to one
 * as in a group, so Tex always sees the thread of its own chat
 * (`docs/decisions/texting-assistant/turn-trust.md`). The Worker's fixed texts
 * are `system` events (`log.js`), never Tex's.
 */

import { conversationPath, readConversation } from "./conversation.js";
import { readGroupMemory } from "./groupTurn.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { EVENT_ID, isChatKey, READ_CHARS, readEvents } from "./log.js";
import { renderEvents, replyingTo, speaker, TIME_OF, words } from "./logRender.js";
import { CANCEL_PREFIX, RUNNING_PREFIX } from "./steer.js";
import { sentByItself, withSentByItself } from "./sentByItself.js";
import { dayFromLedger, earlierFromLedger, readLedger } from "./ledgerHistory.js";
import { ledgerPlace } from "./ledger.js";
import { deskLedger } from "./history.js";
import { DESK_LEDGER } from "../texStore/desk.js";

const MAX_COVERS = 32;
const TURN = /^[A-Za-z0-9_-]{8,64}$/;
export const TURNS_PREFIX = ".context/agent/turns/";
/** Older than this, a turn record or a running or cancel mark is pruned: twice the log's 24h window. */
const KEEP_MS = 48 * 3_600_000;
const MAX_PRUNED = 100;

/**
 * Record whether a named turn stayed inside the workspace. Throws when it
 * cannot: no record is untrusted. A record only ever moves toward not clean:
 * `clean: true` is written only where none exists (create-only, and read
 * first for a store that ignores the condition), and `clean: false` always
 * wins. So a caller that reuses a tainted turn's id on a clean exit never
 * launders it, and one that reuses a clean id on a tainted turn taints it.
 * On a store that ignores the condition (B2, Wasabi), the clean record is
 * read back, and a `clean: false` that landed meanwhile is written again.
 * Each call also prunes old records (`pruneTurns`).
 */
export async function recordTurn(store, turn, clean, { now = Date.now() } = {}) {
  if (typeof turn !== "string" || !TURN.test(turn)) return;
  const key = `${TURNS_PREFIX}${turn}.json`;
  const tainted = JSON.stringify({ clean: false });
  if (clean !== true) await store.put(key, tainted);
  else if ((await store.get(key)) === null) {
    await store.put(key, JSON.stringify({ clean: true }), { onlyIf: { absent: true } });
    const back = await store.get(key);
    if (back !== null && JSON.parse(await back.text())?.clean !== true) await store.put(key, tainted);
  }
  // Left over, a record is only kept longer; after the answer where the host allows (a listing and up to 100 reads: about 10 s of a "hi Tex", 2026-10-31).
  const prune = pruneTurns(store, now).catch(() => {});
  if (typeof store.defer === "function") store.defer(prune);
  else await prune;
}

/**
 * Delete `clean: true` turn records and stray running and cancel marks older
 * than 48h, at most 100 a call. One the store cannot date is kept, and so is
 * every `clean: false` record: gone, a reused turn id could record clean over
 * it and launder the events it said.
 */
export async function pruneTurns(store, now = Date.now()) {
  const old = async (prefix) => {
    // lean: first listing page per prefix only, enough while a bucket gains under 1000 a day; page with a cursor past that.
    const page = await store.list({ prefix });
    return (page?.objects ?? []).filter((object) => {
      const at = new Date(object.uploaded ?? 0).getTime();
      return at > 0 && now - at > KEEP_MS;
    }).map((object) => object.key);
  };
  const [turns, running, cancels] = await Promise.all([TURNS_PREFIX, RUNNING_PREFIX, CANCEL_PREFIX].map(old));
  const marks = [...running, ...cancels].slice(0, MAX_PRUNED);
  // lean: kept false records are read again each call, at most 100; skip them by a listing marker if that cost shows.
  const checked = turns.slice(0, MAX_PRUNED - marks.length);
  const clean = await Promise.all(checked.map((key) => cleanTurn(store, key.slice(TURNS_PREFIX.length, -".json".length))));
  await Promise.all([...marks, ...checked.filter((_, i) => clean[i] === true)].map((key) => store.delete(key)));
}

/**
 * Run a turn and record it on every exit (`recordTurn`), before its answer:
 * `run(outcome)` names the turn (`outcome.turn`) and says whether it stayed
 * clean (`outcome.clean`). Only a texted turn the Worker named, as steer
 * takes it (`steer.js` `steerFor`), sets `turn`. A texted yes or no answered
 * with no model is clean; a refusal before any model writes no record (its
 * fixed words are the Worker's `system` event); a turn that threw, or whose
 * `clean` was never set, is not clean.
 */
export async function recordedTurn(store, run, { defer = () => false } = {}) {
  const outcome = { turn: undefined, clean: false };
  try {
    return await run(outcome);
  } finally {
    // After the response on a chat's lean text (`texTiming.js`): until it lands the turn has no record, which reads as not clean, so late fails closed.
    const recorded = recordTurn(store, outcome.turn, outcome.clean === true).catch(() => {});
    if (defer() && typeof store.defer === "function") store.defer(recorded);
    else await recorded;
  }
}

/** A turn's record: `true` clean, `false` recorded not clean, `null` none or unreadable (failed closed). */
async function cleanTurn(store, turn) {
  if (typeof turn !== "string" || !TURN.test(turn)) return null;
  try {
    const object = await store.get(`${TURNS_PREFIX}${turn}.json`);
    const clean = object === null ? undefined : JSON.parse(await object.text())?.clean;
    return typeof clean === "boolean" ? clean : null;
  } catch {
    return null;
  }
}

export const LOG_PREFACE = "(The chat so far, oldest first, as it happened. \"You\" is you. The newest messages, the ones you are answering, come next.)";

/*
  A named conversation carries its recent turns into this one. Only a name
  from `conversation.js`'s fixed list, never a path, and only on a grant that
  can write: the history is a file in the bucket, and a read-only grant writes
  nothing, so it gets a turn with no memory rather than a write it does not
  hold. Kept in the default context, the one this grant was approved against.
  A group chat remembers in its own file, never the tagger's texts; its turns
  are other people's words, so untrusted (`groupTurn.js`).
*/
export async function turnHistory(store, session, body, { runner, group, dispatch, job = false, time = undefined }) {
  const conversation = !runner && group === null && conversationPath(body.conversation) !== null && hasScope(session, SCOPE_WRITE) ? body.conversation : null;
  const read = () => readConversation(store, conversation, job ? { entries: JOB_HISTORY_ENTRIES } : {});
  const history = group !== null ? await readGroupMemory(store, group, dispatch, time ? { time } : {}) : conversation === null ? [] : await read(); // the one record in the person's object (`history.js`), never a copy
  return { conversation, history };
}

/** The log's history and question for a turn that names what it covers, or null for today's turn. */
export async function loggedTurn(store, body, { group = null, timeZone = "UTC", warm = null, record = null, ledger = null } = {}) {
  const covers = body?.covers;
  if (!Array.isArray(covers) || covers.length === 0 || covers.length > MAX_COVERS || !covers.every((id) => typeof id === "string" && EVENT_ID.test(id))) return null;
  if (!isChatKey(body.chat)) return null;
  // The chat's newest texts come from its ledger, the one place they are written (`textingRoutes.js`); the bucket's log only for a
  // chat that keeps no ledger. A ledger that misses a text this turn covers is counted, never its words, and the turn is today's.
  const day = () => {
    if (ledger === null) return readEvents(store, body.chat);
    return Promise.resolve(ledger).then((read) => dayFromLedger(read?.entries, body.chat, covers)).catch(() => null).then((events) => {
      if (events !== null) return events;
      console.log(JSON.stringify({ event: "tex_turn_day_missed" }));
      return [];
    });
  };
  const [events, read] = await Promise.all([warm === null ? day() : warm.events(body.chat, day), ledger]);
  const wanted = new Set(covers);
  const covered = events.filter((event) => wanted.has(event.id));
  if (covered.length !== wanted.size) return null;
  const question = covered
    .filter((event) => event.from?.kind === "person")
    .map((event) => (group !== null ? `${speaker(event.from)}: ${words(event)}` : words(event)))
    .join("\n");
  if (question === "") return null;
  // A group is shown its whole log, whoever has joined or left since (the owner, 2026-11-02): no cut by the people a text was said in front of.
  const shown = events.filter((event) => !wanted.has(event.id));
  // Everything before the day the turn holds, from the chat's ledger (`ledgerHistory.js`).
  const earlier = Array.isArray(read?.entries) ? earlierFromLedger(read.entries, read.chat, { before: events.length > 0 ? events[0].at : Number.MAX_SAFE_INTEGER, chars: Math.max(0, READ_CHARS - shown.reduce((sum, event) => sum + String(event.text ?? "").length, 0)), known: new Set(events.map((event) => event.id)) }) : { events: [], tools: new Map() };
  // A one-to-one chat's check-ins and routine texts are in the person's record, not the log (`sentByItself.js`).
  const own = group === null && record !== null ? sentByItself(await record, [...earlier.events, ...events], { chat: body.chat, newest: Math.max(...covered.map((event) => event.at)) }) : { shown: [] };
  const transcript = renderEvents(withSentByItself([...earlier.events, ...shown], own.shown), { timeZone, answeredBy: [...earlier.events, ...events], tools: earlier.tools });
  // What the texts it answers were typed under, quoted in full as the transcript shows that message (`logRender.js` `replyingTo`).
  const byId = new Map([...earlier.events, ...events].map((event) => [event.id, event]));
  const replying = covered.map((event) => replyingTo(event, byId, TIME_OF(timeZone))).filter((line) => line !== "");
  return { covered, history: transcript === "" ? [] : [{ role: "user", text: `${LOG_PREFACE}\n\n${transcript}` }], question, replying };
}

/**
 * What a background job's part reads of the chat: its newest entries only, for the earlier-texts tool, kept files and
 * the words that vouch for an address. Its prompt shows none of them (`texEntryPoint.js`): it works from its own record, the
 * brief, finish line, their later texts, its last answer and the advisor's advice (`background.js` `jobPrompt`).
 * On 2026-10-31 every part re-read the last 150 messages, about 5s each, and three restarted jobs copied the chat's
 * "On it: ... restarted" lines as their answer.
 */
export const JOB_HISTORY_ENTRIES = 30;

/**
 * Today's history and the chat's event log, side by side: what a turn reads before its model (`texEntryPoint.js`).
 * `time` times each part as its own step (`memory`, `ledger`, `log`, and in a group the memory's notes and its ledger;
 * the entry point names them `history_*`), so the
 * second a group's history takes is never guessed at (2026-11-04); by default nothing is timed.
 */
const UNTIMED = { memory: (run) => run(), ledger: (run) => run(), log: (run) => run(), groupReads: (run) => run(), groupLedger: (run) => run() };
export function turnReads(store, session, body, { runner, group, dispatch, warm, timeZone, job = false, time = UNTIMED }) {
  const today = time.memory(() => turnHistory(store, session, body, { runner, group, dispatch, job, time: { reads: time.groupReads, ledger: time.groupLedger } }));
  const started = job ? null : chatLedger(store, session);
  // No ledger stays null: the log is then read from the bucket (`loggedTurn`).
  const ledger = started === null ? null : time.ledger(() => started);
  return Promise.all([today, runner ? null : time.log(() => loggedTurn(store, body, { group, timeZone, warm, record: today.then((read) => read.history).catch(() => []), ledger }))]);
}

/** The chat's ledger as a turn reads it (`ledgerHistory.js`), started now, or null when the session keeps none. */
function chatLedger(store, session) {
  const place = ledgerPlace(session);
  const ledger = place !== null && typeof store?.texLedger === "function" ? store.texLedger(place.owner.chat ?? null) : null;
  if (ledger === null) return null;
  const first = place.chat === DESK_LEDGER.chat && place.owner.person ? deskLedger(store) : Promise.resolve(null); // a person's: the desk's page, read with their record
  return first.then((page) => readLedger(ledger, place.chat, { first: page })).then((entries) => ({ entries, chat: place.chat }));
}
