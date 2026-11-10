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
import { dayFromLedger, earlierFromLedger, faded, readLedger, summaryLines } from "./ledgerHistory.js";
import { ledgerPlace } from "./ledger.js";
import { deskLedger } from "./history.js";
import { DESK_LEDGER } from "../texStore/desk.js";
import { MAX_CARRIED_CALLS, stretchSince, stretchTurns } from "./stretch.js";
import { groupQuestion } from "./groupLedgerHistory.js";

const MAX_COVERS = 32;
export const TURNS_PREFIX = ".context/agent/turns/";
/** Older than this, a left-over turn record or a running or cancel mark is pruned: twice the log's 24h window. */
const KEEP_MS = 48 * 3_600_000;
const MAX_PRUNED = 100;

/**
 * Delete turn records (`.context/agent/turns/`, no longer written or read:
 * a turn's trust is its own, `docs/decisions/texting-assistant/turn-trust.md`)
 * and stray running and cancel marks older than 48h, at most 100 a call. One
 * the store cannot date is kept.
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
  const [marks, turns] = await Promise.all([Promise.all([RUNNING_PREFIX, CANCEL_PREFIX].map(old)).then((found) => found.flat()), old(TURNS_PREFIX)]);
  await Promise.all([...marks, ...turns].slice(0, MAX_PRUNED).map((key) => store.delete(key)));
}

/**
 * Run a turn, then prune old marks (`pruneTurns`) on every exit of a named
 * turn (`outcome.turn`: a texted turn the Worker named, as steer takes it),
 * after the response where the host allows (`defer`, a chat's lean text:
 * `texTiming.js`). Nothing is recorded from `outcome`.
 */
export async function recordedTurn(store, run, { defer = () => false } = {}) {
  const outcome = { turn: undefined, clean: false };
  try {
    return await run(outcome);
  } finally {
    if (typeof outcome.turn === "string") {
      const prune = pruneTurns(store).catch(() => {});
      if (defer() && typeof store.defer === "function") store.defer(prune);
      else await prune;
    }
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
export async function loggedTurn(store, body, { group = null, timeZone = "UTC", warm = null, record = null, ledger = null, grant = null } = {}) {
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
  // The stretch's earlier turns, carried as messages with their tool calls and results (`stretch.js`), and left out of the rendered log.
  const carried = await carriedStretch(read, covered, group, grant);
  const before = (event) => carried.since === null || event.at < carried.since;
  const shown = events.filter((event) => !wanted.has(event.id));
  // Days are aged from the newest text it answers: that day and the one before whole, older ones faded (`faded`).
  const answering = Math.max(...covered.map((event) => event.at));
  // Everything before the day the turn holds, from the chat's ledger (`ledgerHistory.js`).
  const earlier = Array.isArray(read?.entries) ? earlierFromLedger(read.entries, read.chat, { before: events.length > 0 ? events[0].at : Number.MAX_SAFE_INTEGER, chars: Math.max(0, READ_CHARS - shown.filter(before).reduce((sum, event) => sum + String(event.text ?? "").length, 0)), known: new Set(events.map((event) => event.id)), fade: true, fadeFrom: answering }) : { events: [], tools: new Map(), summaries: [] }; // older days faded by age (`ledgerHistory.js` `faded`)
  // A one-to-one chat's check-ins and routine texts are in the person's record, not the log (`sentByItself.js`).
  const own = group === null && record !== null ? sentByItself(await record, [...earlier.events, ...events], { chat: body.chat, newest: Math.max(...covered.map((event) => event.at)) }) : { shown: [] };
  const all = withSentByItself([...earlier.events, ...shown.map((event) => faded(event, answering))], own.shown);
  const transcript = renderEvents(all.filter(before), { timeZone, answeredBy: [...earlier.events, ...events], tools: earlier.tools });
  // What the texts it answers were typed under, quoted in full as the transcript shows that message (`logRender.js` `replyingTo`).
  const byId = new Map([...earlier.events, ...events].map((event) => [event.id, event]));
  const replying = covered.map((event) => replyingTo(event, byId, TIME_OF(timeZone))).filter((line) => line !== "");
  // Days older than every text shown come first as their night-after summaries (`daySummaries.js`).
  const told = [summaryLines(earlier.summaries), transcript].filter((part) => part !== "").join("\n\n");
  // The pieces the conversation threads re-show the chat from (`threadedTurn.js`).
  const parts = { shown: all, since: carried.since, answeredBy: [...earlier.events, ...events], tools: earlier.tools, summaries: earlier.summaries, answering, timeZone, byId };
  return { covered, history: [...(told === "" ? [] : [{ role: "user", text: `${LOG_PREFACE}\n\n${told}` }]), ...carried.turns], carried: carried.turns, question, replying, parts };
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
const UNTIMED = { memory: (run) => run(), ledger: (run) => run(), log: (run) => run(), group: {} };
export function turnReads(store, session, body, { runner, group, dispatch, warm, timeZone, job = false, time = UNTIMED }) {
  const today = time.memory(() => turnHistory(store, session, body, { runner, group, dispatch, job, time: time.group ?? {} }));
  const started = job ? null : chatLedger(store, session);
  // No ledger stays null: the log is then read from the bucket (`loggedTurn`).
  const ledger = started === null ? null : time.ledger(() => started);
  return Promise.all([today, runner ? null : time.log(() => loggedTurn(store, body, { group, timeZone, warm, record: today.then((read) => read.history).catch(() => []), ledger, grant: session?.grantId ?? null }))]);
}

/** The chat's ledger as a turn reads it (`ledgerHistory.js`), started now, or null when the session keeps none. */
function chatLedger(store, session) {
  const place = ledgerPlace(session);
  const ledger = place !== null && typeof store?.texLedger === "function" ? store.texLedger(place.owner.chat ?? null) : null;
  if (ledger === null) return null;
  const first = place.chat === DESK_LEDGER.chat && place.owner.person ? deskLedger(store) : Promise.resolve(null); // a person's: the desk's page, read with their record
  return first.then((page) => readLedger(ledger, place.chat, { first: page })).then((entries) => ({ entries, chat: place.chat, ledger }));
}

/**
 * The chat's current stretch (`stretch.js`): when it began and its earlier turns as history, each answer with the
 * calls it made, read whole (the turn's own read is slim). None after an hour quiet, or when the ledger can't be read.
 */
async function carriedStretch(read, covered, group, grant) {
  const none = { since: null, turns: [] };
  const since = stretchSince(read?.entries);
  if (since === null || typeof read?.ledger?.read !== "function") return none;
  try {
    const tools = (await read.ledger.read(read.chat, { kinds: ["tool"], since, limit: MAX_CARRIED_CALLS }))?.entries ?? [];
    const askedNow = [...new Set(covered.filter((event) => event.from?.kind === "person").map((event) => event.from?.who ?? event.from?.name ?? ""))];
    const turns = stretchTurns(read.entries, tools, { since, covered: new Set(covered.map((event) => event.id)), group: group !== null, asker: askedNow.length === 1 ? askedNow[0] : null, grant, ...(group !== null ? { question: groupQuestion } : {}) });
    return turns.length === 0 ? none : { since, turns };
  } catch (error) {
    console.log(JSON.stringify({ event: "tex_stretch_unread", reason: String(error?.name ?? "error").slice(0, 40) }));
    return none;
  }
}
