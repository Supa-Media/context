/**
 * A chat turn's history, by conversation (`conversationThreads.js`): the
 * chat's threads read, the new text sorted by the classifier, and the chat
 * re-shown from what `loggedTurn.js` already read (its `parts`): the thread
 * list, the suggested thread's older texts, then the last 24 hours word for
 * word, each line tagged with its thread. Texts from before the chat's first
 * thread are shown as before, so nothing drops out on the day threads start.
 *
 * Answers `{history, entries, threads, suggested, read_thread, respond}`, or null when the turn
 * keeps the history it had (no log, threads off). The entries are the
 * classifier's, for the turn to write after it answers.
 */

import { classifyText, foldThreads, readThreadTool, readThreads, RECENT_MS, threadOfEvents, threadsPrompt, verdictEntries } from "./conversationThreads.js";
import { summaryLines } from "./ledgerHistory.js";
import { renderEvents, speaker, words } from "./logRender.js";
import { lastTexBefore } from "./respond.js";

/** What the threaded history opens with. */
export const THREADED_PREFACE = "(The chat's conversations, then its last 24 hours of texts, oldest first, as they happened. \"You\" is you. The newest messages, the ones you are answering, come next.)";

// With the date, not the weekday alone: a week-old "Sun" read as yesterday's (Dev2, 2026-11-10: "ALWAYS be showing the date").
export const DAY_TIME = (timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** One event as one line, for the classifier and the suggested thread. */
export const lineOf = (event, format) => `[${format.format(new Date(event.at)).replace(/ /g, " ")}] ${speaker(event.from)}: ${words(event)}`;

export async function threadedTurn({ logged, ledger, chat, group = false, config, metadata, request, now = Date.now(), log = (line) => console.log(line) }) {
  const parts = logged?.parts;
  if (!parts || ledger === null || typeof chat !== "string") return null;
  const began = Date.now();
  const read = await readThreads(ledger, chat);
  const format = DAY_TIME(parts.timeZone);
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
  const { threads, start } = entries.length > 0 ? foldThreads([...read.entries, ...entries]) : read;
  log(JSON.stringify({ event: "tex_threads", verdict: verdict === null ? "none" : verdict.thread === "new" ? "new" : "continued", respond: verdict?.respond ?? "none", ...(verdict?.place ? { place: verdict.place } : {}), reopened: entries[0]?.reopened === true, finished: Math.max(0, entries.length - 1), threads: threads.length, open: threads.filter((thread) => thread.status === "open").length, ms: Date.now() - began }));
  if (start === null) return null; // no thread yet, none made: the chat as it was shown
  const tags = threadOfEvents(threads, parts.shown);
  const cutoff = parts.answering - RECENT_MS;
  // The last day, and whatever no thread holds (older than the chat's first thread, or a group text Tex never answered,
  // which no verdict sorted); the rest is in its threads.
  const kept = parts.shown.filter((event) => event.at >= cutoff || event.at < start || !tags.has(event.id));
  const suggested = written === null ? null : threads.find((thread) => thread.id === written.id) ?? null;
  const older = suggested === null ? [] : parts.shown.filter((event) => event.at < cutoff && event.at >= start && tags.get(event.id) === suggested.id).map((event) => lineOf(event, format));
  const listed = threadsPrompt({ threads, suggested, fresh: verdict?.thread === "new", older, when: (at) => format.format(new Date(at)).replace(/ /g, " ") });
  const transcript = renderEvents(kept, { timeZone: parts.timeZone, answeredBy: parts.answeredBy, tools: parts.tools, tags });
  const pastSummaries = kept.some((event) => event.at < start) ? summaryLines(parts.summaries) : "";
  const told = [listed, pastSummaries, transcript].filter((part) => part !== "").join("\n\n");
  const render = (id) => parts.shown.filter((event) => tags.get(event.id) === id).map((event) => lineOf(event, format)).join("\n");
  // Whether to answer at all, and where (`respond.js`): the verdict's part, with Tex's last text before these for code's floor.
  const respond = verdict === null ? null : { respond: verdict.respond, ...(verdict.emoji ? { emoji: verdict.emoji } : {}), ...(verdict.place ? { place: verdict.place } : {}), ...(verdict.why ? { why: verdict.why } : {}), ...lastTexBefore(parts.shown, covered), repliesToTex: (logged.covered ?? []).some((event) => typeof event.replyTo === "string" && parts.byId?.get(event.replyTo)?.from?.kind === "tex") };
  return { history: [{ role: "user", text: `${THREADED_PREFACE}\n\n${told}` }], entries, threads, suggested: suggested?.id ?? null, read_thread: readThreadTool({ threads, render }), respond };
}
