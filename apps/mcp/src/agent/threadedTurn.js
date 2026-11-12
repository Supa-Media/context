/**
 * A chat turn's history, by conversation (`conversationThreads.js`): the
 * chat's threads read as they stood after the text before, and the chat
 * re-shown from what `loggedTurn.js` already read (its `parts`): the thread
 * list, then the last 24 hours word for
 * word, each line tagged with its thread. Texts from before the chat's first
 * thread are shown as before, so nothing drops out on the day threads start.
 *
 * Answers `{history, threads, read_thread, timeNote, sort}`, or null when the
 * turn keeps the history it had (no log, threads off); `history` is null on a
 * chat with no thread yet. `sort()` runs the classifier on the new text and
 * answers the entries to keep, for the turn to call after it answers.
 */

import { classifyText, foldThreads, readThreadTool, readThreads, RECENT_MS, threadOfEvents, threadsPrompt, verdictEntries } from "./conversationThreads.js";
import { summaryLines } from "./ledgerHistory.js";
import { renderEvents, speaker, words } from "./logRender.js";
import { timeNote } from "./chatTime.js";
import { callbacksPrompt, pickCallbacks } from "./callbacks.js";

/** What the threaded history opens with. */
export const THREADED_PREFACE = "(The chat's conversations, then its last 24 hours of texts, oldest first, as they happened. \"You\" is you. The newest messages, the ones you are answering, come next.)";

// With the date, not the weekday alone: a week-old "Sun" read as yesterday's (Dev2, 2026-11-10: "ALWAYS be showing the date").
export const DAY_TIME = (timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** One event as one line, for the classifier and the suggested thread. */
export const lineOf = (event, format) => `[${format.format(new Date(event.at)).replace(/ /g, " ")}] ${speaker(event.from)}: ${words(event)}`;

export async function threadedTurn({ logged, ledger, chat, group = false, config, metadata, request, now = Date.now(), log = (line) => console.log(line) }) {
  const parts = logged?.parts;
  if (!parts || ledger === null || typeof chat !== "string") return null;
  const read = await readThreads(ledger, chat);
  const format = DAY_TIME(parts.timeZone);
  // The new text is sorted after the answer has gone, never before it (Dev2, 2026-11-12: "Classifier off the reply
  // path ... Never wait for it"): the turn sees the threads as they stood after the text before, and `sort` keeps
  // this text's verdict for the next turn. Before, the turn waited about 3.4 s for it, and 35% of calls ran past the
  // 4 s cap and came back with nothing.
  const sort = async () => {
    const began = Date.now();
    const before = threadOfEvents(read.threads, parts.shown);
    // What the classifier reads: each thread's last lines, and the chat's.
    const byThread = new Map();
    for (const event of parts.shown) {
      const id = before.get(event.id);
      if (id) byThread.set(id, [...(byThread.get(id) ?? []), lineOf(event, format)]);
    }
    const recent = parts.shown.slice(-12).map((event) => lineOf(event, format));
    const verdict = await classifyText({ threads: read.threads, lines: { byThread, recent }, question: logged.question, replying: logged.replying ?? [], group, config, metadata, timeZone: parts.timeZone, request });
    const covered = (logged.covered ?? []).map((event) => event.id).filter((id) => typeof id === "string");
    const written = verdict === null || covered.length === 0 ? null : verdictEntries(verdict, read.threads, covered, now);
    const entries = written?.entries ?? [];
    const threads = entries.length > 0 ? foldThreads([...read.entries, ...entries]).threads : read.threads;
    log(JSON.stringify({ event: "tex_threads", after: true, verdict: verdict === null ? "none" : verdict.thread === "new" ? "new" : "continued", reopened: entries[0]?.reopened === true, finished: Math.max(0, entries.length - 1), threads: threads.length, open: threads.filter((thread) => thread.status === "open").length, ms: Date.now() - began }));
    return entries;
  };
  const { threads, start } = read;
  // How long the chat was quiet before this text, and an old text it replies to, said in the person's turn (`chatTime.js`).
  const time = timeNote({ covered: logged.covered ?? [], shown: parts.shown, byId: parts.byId ?? new Map(), timeZone: parts.timeZone });
  if (start === null) return { history: null, threads, read_thread: null, timeNote: time, sort }; // no thread yet: the chat as it was shown
  const tags = threadOfEvents(threads, parts.shown);
  const cutoff = parts.answering - RECENT_MS;
  // The last day, and in a one-to-one chat whatever no thread holds (older than the chat's first thread, or not sorted yet); the rest is in its threads.
  // In a group, older texts no thread holds are aged like the rest (Dev2, 2026-11-11): they leave the word-for-word
  // transcript, unless one is still an open ask of Tex, and come back only as old moments that fit (`callbacks.js`).
  // Before, they were kept verbatim at any age, and a four-day-old aside read like this morning's.
  const answered = new Set((parts.answeredBy ?? []).filter((event) => event.from?.kind === "tex" && event.delivered !== false).flatMap((event) => event.covers ?? []));
  const openAsk = (event) => event.from?.kind === "person" && !answered.has(event.id) && (/\btex\b/i.test(String(event.text ?? "")) || parts.byId?.get(event.replyTo)?.from?.kind === "tex");
  const loose = (event) => (group ? openAsk(event) : event.at < start || !tags.has(event.id));
  const stretch = (event) => Number.isSafeInteger(parts.since) && event.at >= parts.since; // the stretch is carried as messages (`stretch.js`)
  const kept = parts.shown.filter((event) => (event.at >= cutoff || loose(event)) && !stretch(event));
  const listed = threadsPrompt({ threads, when: (at) => format.format(new Date(at)).replace(/ /g, " ") });
  const transcript = renderEvents(kept, { timeZone: parts.timeZone, answeredBy: parts.answeredBy, tools: parts.tools, tags, now: parts.answering });
  const pastSummaries = !group && kept.some((event) => event.at < start) ? summaryLines(parts.summaries) : "";
  // Old moments that fit what's said now, with their age and how they landed, just before the last day's texts (`callbacks.js`).
  const inView = new Set(kept.map((event) => event.id));
  const pool = parts.shown.filter((event) => event.at < cutoff && !inView.has(event.id));
  const live = [...parts.shown.filter((event) => event.at >= cutoff).slice(-6), ...(logged.covered ?? [])]; // what's being said now
  const moments = group ? callbacksPrompt(pickCallbacks({ pool, live, all: parts.shown, tags, suggested: null, now: parts.answering }), { now: parts.answering, timeZone: parts.timeZone }) : "";
  const told = [listed, pastSummaries, moments, transcript].filter((part) => part !== "").join("\n\n");
  const render = (id) => parts.shown.filter((event) => tags.get(event.id) === id).map((event) => lineOf(event, format)).join("\n");
  // Whether Tex answers at all is the Worker's judge's (`textDecide.cjs`); where the reply goes is left to the send (no place).
  return { history: [{ role: "user", text: `${THREADED_PREFACE}\n\n${told}` }], threads, read_thread: readThreadTool({ threads, render }), timeNote: time, sort };
}
