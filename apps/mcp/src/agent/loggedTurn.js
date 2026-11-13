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
import { oneLine, renderEvents, replyingTo, speaker, TIME_OF, words } from "./logRender.js";
import { CANCEL_PREFIX, RUNNING_PREFIX } from "./steer.js";
import { sentByItself, withSentByItself } from "./sentByItself.js";
import { dayFromLedger, earlierFromLedger, faded, readLedger, summaryLines } from "./ledgerHistory.js";
import { ledgerPlace } from "./ledger.js";
import { deskLedger } from "./history.js";
import { DESK_LEDGER } from "../texStore/desk.js";
import { carryKey, MAX_CARRIED_CALLS, stretchSince, stretchTurns } from "./stretch.js";
import { groupQuestion } from "./groupLedgerHistory.js";

const MAX_COVERS = 32;
/** Before this, a Worker logged a text cut at 3,000 with no mark and no `left` (`log.js`). */
const OLD_CAP = 3_000;
/**
 * Only an event logged before this moment is taken as cut at the old 3,000 by its length alone; after it only a Worker's `left`
 * counts. lean: a fixed date a week after the gateway half shipped, set to the Worker half's deploy date once it is live.
 */
export const OLD_CAP_UNTIL = Date.UTC(2026, 10, 19);
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

export const MOMENT_PREFACE = "(The chat so far, oldest first, as it happened. \"You\" is you. Nothing new was texted for this turn: what you are asked to do comes next.)";

/**
 * ONE DOOR (Dev2, 2026-11-13: check-ins, job results and new groups read the chat the way a reply does): what a turn that
 * answers no named text is shown of its chat. A routine or check-in, a job's report, a group turn the Worker named nothing
 * for: the same ledger view a reply reads (`loggedTurn` below), aged from now, with nothing covered. Before this, those turns
 * read the old group memory file or, in a 1:1, nothing at all, so a check-in answered a text from the night before.
 * Null when the chat keeps no ledger or it holds nothing to show; the turn then reads today's history as before.
 */
export function momentView(read, { chat = null, timeZone = "UTC", now = Date.now(), grant = null, record = [], group = null } = {}) {
  if (!Array.isArray(read?.entries) || read.entries.length === 0) return null;
  const key = isChatKey(chat) ? chat : read.chat;
  if (!isChatKey(key) || !isChatKey(read.chat)) return null;
  const day = dayFromLedger(read.entries, key, []) ?? [];
  const room = Math.max(0, READ_CHARS - day.reduce((sum, event) => sum + String(event.text ?? "").length, 0));
  const earlier = earlierFromLedger(read.entries, read.chat, { before: day.length > 0 ? day[0].at : Number.MAX_SAFE_INTEGER, chars: room, known: new Set(day.map((event) => event.id)), fade: true, fadeFrom: now, grant });
  const seen = [...earlier.events, ...day.map((event) => faded(event, now))];
  // A one-to-one chat's check-ins and routine texts kept in the person's record, as a reply shows them (`sentByItself.js`).
  const own = group === null ? sentByItself(record, seen, { chat: key, newest: now }) : { shown: [] };
  const all = withSentByItself(seen, own.shown);
  const transcript = all.length === 0 ? "" : renderEvents(all, { timeZone, answeredBy: all, tools: earlier.tools, facts: earlier.facts });
  const told = [summaryLines(earlier.summaries), transcript].filter((part) => part !== "").join("\n\n");
  if (told === "") return null;
  return { history: [{ role: "user", text: `${MOMENT_PREFACE}\n\n${told}` }], shown: all };
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
  // The text as the Worker sent it (`body.question`) when the log kept less of it (2026-11-11: a pasted brief cut at 3,000 read
  // as missing). Only when the event provably is that text cut: the Worker's own `left` (never words a person can type), and the
  // kept words exactly the question's start with the Worker's mark; or, logged before `OLD_CAP_UNTIL`, exactly its first 3,000.
  // Only the newest asked event, and in a group only when every covered text is one person's, so nobody's words land under
  // another's name (security reviews, 2026-11-11 and 2026-11-12).
  const raw = typeof body.question === "string" ? body.question : "";
  const whole = (event) => {
    const kept = words(event);
    if (event.kind !== "text" || raw === "") return kept;
    const left = event.left;
    const proven = Number.isSafeInteger(left) && left > 0 && left < raw.length
      ? kept === oneLine(`${raw.slice(0, raw.length - left)}\n[cut: ${left} more characters]`)
      : left === undefined && event.at < OLD_CAP_UNTIL && raw.length > OLD_CAP && kept === oneLine(raw.slice(0, OLD_CAP));
    return proven ? oneLine(raw) : kept;
  };
  const asked = covered.filter((event) => event.from?.kind === "person");
  const oneSender = typeof asked[0]?.from?.who === "string" && asked.every((event) => event.from?.who === asked[0].from.who);
  const question = group !== null
    ? asked.map((event, i) => `${speaker(event.from)}: ${i === asked.length - 1 && oneSender ? whole(event) : words(event)}`).join("\n")
    : asked.map((event, i) => (i === asked.length - 1 ? whole(event) : words(event))).join("\n");
  if (question === "") return null;
  // A group is shown its whole log, whoever has joined or left since (the owner, 2026-11-02): no cut by the people a text was said in front of.
  // The stretch's earlier turns, carried as messages with their tool calls and results (`stretch.js`), and left out of the rendered log.
  const carried = await carriedStretch(read, covered, group, grant);
  const before = (event) => carried.since === null || event.at < carried.since;
  const shown = events.filter((event) => !wanted.has(event.id));
  // Days are aged from the newest text it answers: that day and the one before whole, older ones faded (`faded`).
  const answering = Math.max(...covered.map((event) => event.at));
  // Everything before the day the turn holds, from the chat's ledger (`ledgerHistory.js`).
  const earlier = Array.isArray(read?.entries) ? earlierFromLedger(read.entries, read.chat, { before: events.length > 0 ? events[0].at : Number.MAX_SAFE_INTEGER, chars: Math.max(0, READ_CHARS - shown.filter(before).reduce((sum, event) => sum + String(event.text ?? "").length, 0)), known: new Set(events.map((event) => event.id)), fade: true, fadeFrom: answering, grant }) : { events: [], tools: new Map(), facts: new Map(), summaries: [] }; // older days faded by age (`ledgerHistory.js` `faded`)
  // A one-to-one chat's check-ins and routine texts are in the person's record, not the log (`sentByItself.js`).
  const own = group === null && record !== null ? sentByItself(await record, [...earlier.events, ...events], { chat: body.chat, newest: Math.max(...covered.map((event) => event.at)) }) : { shown: [] };
  const all = withSentByItself([...earlier.events, ...shown.map((event) => faded(event, answering))], own.shown);
  // Under each earlier text, what its turn read for it, quoted (`toldFacts.js`).
  const transcript = renderEvents(all.filter(before), { timeZone, answeredBy: [...earlier.events, ...events], tools: earlier.tools, facts: earlier.facts });
  // What the texts it answers were typed under, quoted in full as the transcript shows that message (`logRender.js` `replyingTo`).
  const byId = new Map([...earlier.events, ...events].map((event) => [event.id, event]));
  const replying = covered.map((event) => replyingTo(event, byId, TIME_OF(timeZone))).filter((line) => line !== "");
  // Days older than every text shown come first as their night-after summaries (`daySummaries.js`).
  const told = [summaryLines(earlier.summaries), transcript].filter((part) => part !== "").join("\n\n");
  // The pieces the conversation threads re-show the chat from (`threadedTurn.js`).
  const parts = { shown: all, since: carried.since, answeredBy: [...earlier.events, ...events], tools: earlier.tools, facts: earlier.facts, summaries: earlier.summaries, answering, timeZone, byId };
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
export function turnReads(store, session, body, { runner, group, dispatch, warm, timeZone, job = false, moment = runner || group !== null, time = UNTIMED }) {
  const today = time.memory(() => turnHistory(store, session, body, { runner, group, dispatch, job, time: time.group ?? {} }));
  const started = job ? null : chatLedger(store, session);
  // No ledger stays null: the log is then read from the bucket (`loggedTurn`).
  const ledger = started === null ? null : time.ledger(() => started);
  const logged = runner ? Promise.resolve(null) : time.log(() => loggedTurn(store, body, { group, timeZone, warm, record: today.then((read) => read.history).catch(() => []), ledger, grant: carryKey(session) }));
  // A routine, a check-in, a job's report or a group turn that names no text still reads its chat from the ledger, as a reply does (`momentView`); a 1:1 text named nothing keeps today's record.
  const view = ledger === null || !moment ? Promise.resolve(null) : logged.then((named) => (named !== null ? null : Promise.all([ledger, today]).then(([read, held]) => momentView(read, { chat: body?.chat, timeZone, grant: carryKey(session), record: held?.history ?? [], group })))).catch(() => null);
  return Promise.all([today, logged, view]).then(([read, named, moment]) => [{ ...read, view: moment }, named]);
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
