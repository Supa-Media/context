/**
 * A chat's conversations on the Tex page and in its Tex folder (Dev2, 2026-11-07: "mock a special UI for the threads
 * ... make sure it shows up in the Tex Hub and also when you open the Tex folder", then "build it then";
 * `docs/decisions/texting-assistant/conversation-threads.md`).
 *
 *  - `{view: "conversations"}` → `{threads}`: every thread as it stands, open first, then finished, each newest first,
 *    with its title, description, status, when it started and last moved, and how many texts it holds.
 *  - `{view: "conversation", thread}` → `{thread, lines, more}`: that thread's texts and Tex's answers to them, oldest
 *    first, the newest `MAX_LINES` of them (`more` says older ones are kept).
 *
 * Both read the chat's threads ledger (`agent/conversationThreads.js`) and the chat's own ledger; nothing is kept here.
 * Who may, and which chat: `page.js`, as every Tex page route.
 */

import { listedThreads, readThreads } from "../../agent/conversationThreads.js";

/** The most threads one list answers, and the most lines one thread does. */
export const MAX_THREADS = 500;
export const MAX_LINES = 200;
/** Pages of the chat's texts read for one thread, and their size. */
const READ_PAGES = 40;
const READ_PAGE = 2000;
/** A turn's texts can be a little older than the entry that sorted them. */
const SLACK_MS = 24 * 3_600_000;
const THREAD_ID = /^t[1-9][0-9]{0,5}$/;

const listed = (thread) => ({
  id: thread.id,
  title: thread.title,
  description: thread.description,
  status: thread.status,
  started: thread.at,
  last: thread.last,
  texts: thread.texts.length,
});

export async function conversationsView(ledger, chat) {
  const { threads } = await readThreads(ledger, chat);
  // Open first, then finished, each newest first: the order the turn lists them in.
  return { threads: listedThreads(threads, MAX_THREADS).map(listed) };
}

/**
 * Which of `entries` (the chat's texts, oldest first) are this thread's: a person's text it names, and Tex's answer
 * to one: by the texts the answer covers, or, for an older answer that names none, by the texts since the answer
 * before it (as the replay sorted them, `agent/threadsBackfill.js`).
 */
export function threadLines(thread, entries) {
  const mine = new Set(thread.texts);
  const lines = [];
  let since = [];
  for (const entry of entries) {
    const from = entry?.from?.kind;
    if (from === "person") {
      since.push(entry.eid);
      if (mine.has(entry.eid)) lines.push(entry);
      continue;
    }
    if (from !== "tex") continue;
    const covers = Array.isArray(entry.covers) ? entry.covers : [];
    const answers = covers.length > 0 ? covers.some((id) => mine.has(id)) : since.some((id) => mine.has(id));
    since = [];
    if (answers) lines.push(entry);
  }
  return lines;
}

const lineOf = (entry) => ({
  id: entry.eid,
  at: entry.at,
  who: entry.from.kind === "tex" ? "tex" : "person",
  ...(entry.from.kind === "person" && typeof entry.from.name === "string" ? { name: entry.from.name } : {}),
  text: typeof entry.text === "string" ? entry.text : "",
});

export async function conversationView(ledger, chat, id) {
  if (typeof id !== "string" || !THREAD_ID.test(id)) return { thread: null, lines: [], more: false };
  const { threads } = await readThreads(ledger, chat);
  const thread = threads.find((each) => each.id === id) ?? null;
  if (thread === null) return { thread: null, lines: [], more: false };
  const entries = [];
  let after = 0;
  for (let page = 0; page < READ_PAGES; page += 1) {
    const read = await ledger.read(chat, { after, kinds: ["text"], since: Math.max(0, thread.at - SLACK_MS), limit: READ_PAGE, slim: true });
    for (const entry of Array.isArray(read?.entries) ? read.entries : []) {
      if (entry?.kind === "text" && typeof entry.eid === "string" && Number.isSafeInteger(entry.at)) entries.push(entry);
    }
    if (!Number.isSafeInteger(read?.next)) break;
    after = read.next;
  }
  entries.sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
  const lines = threadLines(thread, entries);
  return { thread: listed(thread), lines: lines.slice(-MAX_LINES).map(lineOf), more: lines.length > MAX_LINES };
}
