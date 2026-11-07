/**
 * A chat's conversations, replayed from its whole history (Dev2, 2026-11-07:
 * "did we backfill threads and conversations?", then "Backfill full history").
 *
 * Live turns sort each new text as it comes (`threadedTurn.js`); a chat's texts
 * from before that never were. This replays them through the same classifier,
 * oldest first, one answered turn at a time: the texts a Tex answer covers
 * (`covers`), or, for an older answer that names none, the texts since the
 * answer before it. Each verdict is written to the chat's threads ledger as a
 * live one is, marked `backfill: true` and dated by its newest text, so the
 * chat's threads read in time order.
 *
 * Only texts older than the chat's first live thread entry are replayed, and
 * the classifier is shown only the threads the replay has made: the live ones
 * are newer. New ids still count past every thread, live ones included, so
 * none is taken twice.
 *
 * It runs in parts (`budget` turns, `deadline` ms): each part ends with a
 * `progress` mark, where the next one starts, and the last with the `done`
 * mark (`DONE_ID`); then it does nothing again. Neither mark names a thread,
 * so `foldThreads` passes over them. Answers counts only, never a word.
 *
 * Run from the control plane through `POST /internal/threads/backfill`
 * (`threadsBackfillDoor.js`).
 */

import { asEvent } from "./ledgerHistory.js";
import { classifyText, foldThreads, readThreads, threadOfEvents, threadsChat, verdictEntries } from "./conversationThreads.js";
import { DAY_TIME, lineOf } from "./threadedTurn.js";

export const DONE_ID = "thbackfilldone";
/** What one replayed turn's classifier sees of the chat before it: as the live turn's last lines. */
const WINDOW = 400;
const RECENT_LINES = 12;
/** Per call: the chat's texts read in pages. */
const READ_PAGE = 5000;
const READ_PAGES = 200;
/** No one is waiting: a slow answer is waited for longer than a live turn's. */
const TIMEOUT_MS = 20_000;

/** The chat's texts as events, oldest first: Tex's and the people's, never a system line. */
async function chatEvents(ledger, chat) {
  const events = [];
  const seen = new Set();
  let after = 0;
  for (let page = 0; page < READ_PAGES; page += 1) {
    const read = await ledger.read(chat, { after, kinds: ["text"], limit: READ_PAGE, slim: true });
    for (const entry of Array.isArray(read?.entries) ? read.entries : []) {
      if (entry?.kind !== "text" || typeof entry.eid !== "string" || !Number.isSafeInteger(entry.at) || seen.has(entry.eid)) continue;
      const kind = entry.from?.kind;
      if (kind !== "person" && kind !== "tex") continue;
      seen.add(entry.eid);
      events.push(asEvent(entry, chat));
    }
    if (!Number.isSafeInteger(read?.next)) break;
    after = read.next;
  }
  return events.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The answered turns, oldest first: `{covered, at, index}`, where `covered` is
 * the people's text ids Tex's answer at `index` covers, and `at` the newest of them.
 */
export function answeredTurns(events) {
  const turns = [];
  const done = new Set();
  const byId = new Map();
  let since = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.from?.kind === "person") {
      since.push(event);
      byId.set(event.id, event);
      continue;
    }
    const named = (Array.isArray(event.covers) ? event.covers : []).map((id) => byId.get(id)).filter(Boolean);
    const covered = (named.length > 0 ? named : since).filter((each) => !done.has(each.id));
    since = [];
    if (covered.length === 0) continue;
    for (const each of covered) done.add(each.id);
    turns.push({ covered: covered.map((each) => each.id), at: Math.max(...covered.map((each) => each.at)), index, texts: covered });
  }
  return turns;
}

/**
 * One part of the replay. `classify(input)` is `classifyText`'s call with its
 * config bound. Answers `{state, turns, written, failed, left}`: `state` is
 * `done` (already replayed), `none` (no texts), `would` (dry run: `left`
 * counts the turns to replay), `partly` (more to go) or `finished`.
 */
export async function backfillThreads({ ledger, chat, classify, dryRun = false, budget = 25, deadline = 45_000, now = Date.now, timeZone = "UTC" }) {
  const began = now();
  const read = await readThreads(ledger, chat);
  if (read.entries.some((entry) => entry?.id === DONE_ID)) return await retryUnsorted({ ledger, chat, classify, read, dryRun, budget, deadline, now, began, timeZone });
  const live = read.entries.filter((entry) => entry?.backfill !== true && Number.isSafeInteger(entry?.at));
  const liveStart = live.length > 0 ? Math.min(...live.map((entry) => entry.at)) : Number.MAX_SAFE_INTEGER;
  const replayed = read.entries.filter((entry) => entry?.backfill === true && Number.isSafeInteger(entry?.at));
  const from = replayed.length > 0 ? Math.max(...replayed.map((entry) => entry.at)) : Number.NEGATIVE_INFINITY;
  const events = (await chatEvents(ledger, chat)).filter((event) => event.at < liveStart);
  if (events.length === 0) {
    if (!dryRun) await ledger.append(threadsChat(chat), [{ v: 1, id: DONE_ID, at: began, kind: "thread", backfill: true, done: true }]);
    return { state: "none", turns: 0, written: 0, failed: 0, left: 0 };
  }
  const turns = answeredTurns(events).filter((turn) => turn.at > from);
  if (dryRun) return { state: "would", turns: 0, written: 0, failed: 0, left: turns.length };
  const format = DAY_TIME(timeZone);
  let mine = foldThreads(replayed).threads;
  let all = read.threads;
  let entriesSoFar = [...read.entries];
  let written = 0;
  let failed = 0;
  let count = 0;
  let last = from;
  for (const turn of turns) {
    if (count >= budget || now() - began > deadline) break;
    count += 1;
    const input = turnInput(turn, events, mine, format);
    let verdict = await classify(input);
    if (verdict === null) verdict = await classify(input); // once more: a missed one stays unsorted for good
    last = turn.at;
    if (verdict === null) {
      failed += 1;
      continue;
    }
    // Ids count past every thread, the live ones too; the verdict can only name the replay's own.
    const { entries } = verdictEntries(verdict, [...mine, ...all.filter((thread) => !mine.some((each) => each.id === thread.id))], turn.covered, turn.at);
    const marked = entries.map((entry) => ({ ...entry, backfill: true }));
    await ledger.append(threadsChat(chat), marked);
    written += marked.length;
    entriesSoFar = [...entriesSoFar, ...marked];
    mine = foldThreads(entriesSoFar.filter((entry) => entry?.backfill === true)).threads;
    all = foldThreads(entriesSoFar).threads;
  }
  const finished = count === turns.length;
  const mark = finished
    ? { v: 1, id: DONE_ID, at: began, kind: "thread", backfill: true, done: true }
    : { v: 1, id: `thbackfill${last}`, at: last, kind: "thread", backfill: true, progress: true };
  // A part that sorted nothing still moves on past the turns it tried.
  if (finished || Number.isFinite(last)) await ledger.append(threadsChat(chat), [mark]);
  return { state: finished ? "finished" : "partly", turns: count, written, failed, left: turns.length - count };
}

/** The input the classifier is shown for one replayed turn: `mine` as they stood before it. */
function turnInput(turn, events, mine, format) {
  const shown = events.slice(Math.max(0, turn.index - WINDOW), turn.index).filter((event) => event.at <= turn.at);
  const tags = threadOfEvents(mine, shown);
  const byThread = new Map();
  for (const event of shown) {
    const id = tags.get(event.id);
    if (id) byThread.set(id, [...(byThread.get(id) ?? []), lineOf(event, format)]);
  }
  const question = turn.texts.map((event) => event.text ?? "").join("\n");
  return { threads: mine, lines: { byThread, recent: shown.slice(-RECENT_LINES).map((event) => lineOf(event, format)) }, question, replying: [], timeoutMs: TIMEOUT_MS };
}

/**
 * After the replay: the turns it left unsorted (the classifier failed twice), asked once more, each shown the
 * replay's threads as they stood at its time. A turn asked here and missed again is marked (`thretry<at>`) and
 * never asked again, so this ends. `done` when there is nothing left to ask.
 */
async function retryUnsorted({ ledger, chat, classify, read, dryRun, budget, deadline, now, began, timeZone }) {
  const nothing = { state: "done", turns: 0, written: 0, failed: 0, left: 0 };
  const replayed = read.entries.filter((entry) => entry?.backfill === true && Number.isSafeInteger(entry?.at));
  const done = replayed.find((entry) => entry.id === DONE_ID);
  const live = read.entries.filter((entry) => entry?.backfill !== true && Number.isSafeInteger(entry?.at));
  const liveStart = live.length > 0 ? Math.min(...live.map((entry) => entry.at)) : Number.MAX_SAFE_INTEGER;
  const sorted = new Set(read.threads.flatMap((thread) => thread.texts));
  const asked = new Set(replayed.filter((entry) => entry.retried === true).map((entry) => entry.at));
  const events = (await chatEvents(ledger, chat)).filter((event) => event.at < liveStart && event.at <= (done?.at ?? Number.MAX_SAFE_INTEGER));
  const turns = answeredTurns(events).filter((turn) => !turn.covered.some((id) => sorted.has(id)) && !asked.has(turn.at));
  if (turns.length === 0) return nothing;
  if (dryRun) return { state: "would", turns: 0, written: 0, failed: 0, left: turns.length };
  const format = DAY_TIME(timeZone);
  let entriesSoFar = [...read.entries];
  let written = 0;
  let failed = 0;
  let count = 0;
  for (const turn of turns) {
    if (count >= budget || now() - began > deadline) break;
    count += 1;
    const before = entriesSoFar.filter((entry) => entry?.backfill === true && entry.at <= turn.at);
    const mine = foldThreads(before).threads;
    const verdict = await classify(turnInput(turn, events, mine, format));
    if (verdict === null) {
      failed += 1;
      await ledger.append(threadsChat(chat), [{ v: 1, id: `thretry${turn.at}`, at: turn.at, kind: "thread", backfill: true, retried: true }]);
      entriesSoFar = [...entriesSoFar, { id: `thretry${turn.at}`, at: turn.at, kind: "thread", backfill: true, retried: true }];
      continue;
    }
    // A new one takes the next id past every thread there is now; the verdict can only name one that stood then.
    const { entries } = verdictEntries(verdict, [...mine, ...foldThreads(entriesSoFar).threads.filter((thread) => !mine.some((each) => each.id === thread.id))], turn.covered, turn.at);
    const marked = entries.map((entry) => ({ ...entry, backfill: true, retried: true }));
    await ledger.append(threadsChat(chat), marked);
    written += marked.length;
    entriesSoFar = [...entriesSoFar, ...marked];
  }
  const left = turns.length - count;
  return { state: left === 0 ? "finished" : "partly", turns: count, written, failed, left };
}
