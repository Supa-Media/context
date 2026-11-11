/**
 * CONVERSATION THREADS (Dev2, 2026-11-07: "a conversation classifier ... that
 * decides if a message is part of an existing convo open, or is a new convo";
 * "keep it in a conversations.ledger.json file ... so we could run the
 * history.ledger.json through the classifier, and regenerate the conversation
 * threads"; "let's get rid of shadow mode and just launch it").
 *
 * Before a chat turn's model runs, one Haiku call reads the chat's open
 * threads and the new text, and says which thread the text continues (or that
 * it starts one), the thread's description as it now stands, and which threads
 * the latest texts finished. Its answer is kept in the chat's threads ledger:
 * the same Tex object as the chat's ledger, under the chat's name plus
 * `.threads` (`THREADS_SUFFIX`), appended and never edited, newest entry per
 * thread wins. It is an index, rebuilt from the chat's ledger by replaying it,
 * so it is not exported (the chat's ledger is).
 *
 * The turn is then shown (`threadsHistory`): up to `MAX_LISTED` threads, one
 * line each (open first, then the most recently finished; older ones drop out
 * of the prompt as threads close), the suggested thread with its texts older
 * than the last day, and the last 24 hours word for word, each line tagged
 * with its thread. Texts from before the chat's first thread entry are shown
 * as before, so a chat loses nothing on the day this starts. `read_thread`
 * opens any thread, or lists them all.
 *
 * Finishing is the consequential call (review of the proposal, 2026-11-07):
 * a thread finishes only on evidence in the texts (answered and acknowledged,
 * done, or dropped by someone); silence never finishes one, and an ask of
 * theirs Tex has not answered keeps its thread open. A wrong thread costs
 * little: the last day is always shown and any thread can be read.
 *
 * Off with `CONVERSATION_THREADS=off`. When the call fails or is late, the turn
 * still gets the thread list and the last day, with no suggestion.
 */

import { requestViaGateway } from "./aiGateway.js";
import { ledgerPlace, ledgerWriter } from "./ledger.js";
import { firstObject } from "./replyJudge.js";
import { withArchitecture } from "./texArchitecture.js";
import { DESCRIPTION_CHARS, foldThreads, listedThreads, MAX_LISTED, THREADS_SUFFIX, TITLE_CHARS } from "./threadsFold.js";

export { foldThreads, listedThreads, MAX_LISTED, THREADS_SUFFIX };

export const THREADS_MODEL = "anthropic/claude-haiku-5-5";
export const THREADS_EFFORT = "low";
export const THREADS_TIMEOUT_MS = 4_000;
/** How far back the chat is shown word for word once its threads have started. */
export const RECENT_MS = 24 * 60 * 60 * 1000;
/** What the classifier is shown of each candidate thread, and of the chat just before the new text. */
const CANDIDATES = 30;
const LAST_LINES = 3;
const RECENT_LINES = 12;
const LINE_CHARS = 300;
/** The most thread entries one read takes: far more than any chat's threads. */
const MAX_READ = 5000;
const MAX_PAGES = 20;

export const THREADS_SYSTEM = `You sort a text chat with Tex (an assistant people text) into conversation threads. A thread is one subject: a question and its answer, a task, a plan, a debate, a run of jokes about one thing. Several can be open at once and interleave. Time apart does not split a thread; a new subject does.

You are given whether the chat is a group chat or a 1:1 with Tex (CHAT), the chat's threads (id, open or finished, title, description, its last lines), the chat's last lines, and the NEW TEXT. In the lines "You" is Tex and a person is "@name". Decide:
1. thread: the id of the thread the new text continues, or "new". A text "replying to" an old message is a hint, not the answer: people often reply under an old bubble while changing subject, so go by what the text is about. A finished thread the text clearly picks up again is that thread (it reopens). A short reaction ("lol", "thanks", a tapback) belongs to the thread it reacts to.
2. title: for "new", a 3 to 6 word title in plain words; otherwise the thread's title, kept unless it is now wrong.
3. description: that thread's one or two sentences as they now stand, with the new text in it: what it is about and where it stands (what is asked, what is waiting on whom). At most 240 characters.
4. finished: ids of OTHER open threads the chat's last lines show are done. Only on evidence: the ask was answered and they acknowledged it or moved on from it by saying so, the task was done, or someone dropped it. Silence never finishes a thread. A question of theirs that Tex has not answered keeps its thread open. When unsure, leave it open.
5. place: "under" when Tex's reply could be read as answering a different text (other texts came after it, several conversations are interleaving, or it picks up an older subject), else "plain".

Answer with JSON only: {"thread":"t3"|"new","title":"...","description":"...","finished":["t1"],"place":"under"|"plain"}`;

/** Where a reply goes: under the text it answers, or plain in the chat; anything else is none, and the Worker decides. */
export const PLACES = ["under", "plain"];

/** The threads ledger's chat name for a chat. */
export const threadsChat = (chat) => `${chat}${THREADS_SUFFIX}`;

/** Whether threads run for this deployment. */
export const threadsOn = (env) => String(env?.CONVERSATION_THREADS ?? "").toLowerCase() !== "off";

/** The chat's threads, read from its threads ledger, with the entries they were folded from; empty when there is none or it can't be read. */
export async function readThreads(ledger, chat) {
  if (ledger === null || typeof ledger?.read !== "function" || typeof chat !== "string") return { ...foldThreads([]), entries: [] };
  try {
    // Paged: a chat replayed from its whole history (`threadsBackfill.js`) can hold more entries than one read.
    const entries = [];
    let after = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const read = await ledger.read(threadsChat(chat), { after, limit: MAX_READ });
      if (Array.isArray(read?.entries)) entries.push(...read.entries);
      if (!Number.isSafeInteger(read?.next)) break;
      after = read.next;
    }
    return { ...foldThreads(entries), entries };
  } catch {
    return { ...foldThreads([]), entries: [] };
  }
}

/** The thread each event is in: a text by its own entry, Tex's answer by the texts it answered. */
export function threadOfEvents(threads, events) {
  const of = new Map();
  for (const thread of threads) for (const id of thread.texts) of.set(id, thread.id);
  for (const event of Array.isArray(events) ? events : []) {
    if (of.has(event.id)) continue;
    const covered = (Array.isArray(event.covers) ? event.covers : []).map((id) => of.get(id)).find(Boolean);
    if (covered) of.set(event.id, covered);
  }
  return of;
}

const oneLine = (text, max = LINE_CHARS) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The classifier's message: the candidate threads with their last lines, the chat's last lines, the new text. */
export function threadsMessage({ threads, lines, question, replying = [], group = false }) {
  const candidates = listedThreads(threads, CANDIDATES);
  const parts = [`CHAT: ${group ? "a group chat" : "a 1:1 with Tex"}`, "", "THREADS"];
  if (candidates.length === 0) parts.push("(none yet)");
  for (const thread of candidates) {
    parts.push(`${thread.id} · ${thread.status} · ${thread.title}: ${thread.description}`);
    for (const line of (lines.byThread.get(thread.id) ?? []).slice(-LAST_LINES)) parts.push(`    ${oneLine(line)}`);
  }
  parts.push("", "THE CHAT'S LAST LINES", ...(lines.recent.length > 0 ? lines.recent.map((line) => oneLine(line)) : ["(nothing yet)"]));
  parts.push("", "NEW TEXT", oneLine(question, 2_000), ...replying.map((line) => `(${oneLine(line)})`));
  return parts.join("\n");
}

/** The classifier's answer, checked: `{thread, title, description, finished, place?}`, or null when it isn't one. */
export function readVerdict(text, threads) {
  const found = firstObject(String(text ?? ""));
  if (found === null) return null;
  const known = new Set(threads.map((thread) => thread.id));
  const thread = found.thread === "new" ? "new" : typeof found.thread === "string" && known.has(found.thread) ? found.thread : null;
  if (thread === null) return null;
  const title = oneLine(found.title, TITLE_CHARS);
  const description = oneLine(found.description, DESCRIPTION_CHARS);
  if (thread === "new" && title === "") return null;
  const finished = (Array.isArray(found.finished) ? found.finished : []).filter((id) => typeof id === "string" && known.has(id) && id !== thread);
  return { thread, title, description, finished: [...new Set(finished)], ...(PLACES.includes(found.place) ? { place: found.place } : {}) };
}

/** The next new thread's id. */
export function nextThreadId(threads) {
  const top = threads.reduce((max, thread) => Math.max(max, Number(thread.id.slice(1)) || 0), 0);
  return `t${top + 1}`;
}

/** The ledger entries a verdict writes: the text's thread (opened, continued or reopened), and each thread it finished. */
export function verdictEntries(verdict, threads, covered, at = Date.now()) {
  const id = verdict.thread === "new" ? nextThreadId(threads) : verdict.thread;
  const was = threads.find((thread) => thread.id === id);
  const entries = [{
    v: 1,
    id: `th${at}${id}`,
    at,
    kind: "thread",
    thread: id,
    status: "open",
    ...(verdict.title !== "" && verdict.title !== was?.title ? { title: verdict.title } : {}),
    ...(verdict.description !== "" ? { description: verdict.description } : {}),
    texts: covered,
    ...(was?.status === "finished" ? { reopened: true } : {}),
  }];
  for (const done of verdict.finished) {
    if (threads.find((thread) => thread.id === done)?.status !== "open") continue;
    entries.push({ v: 1, id: `th${at}${done}x`, at, kind: "thread", thread: done, status: "finished" });
  }
  return { id, entries };
}

/** One classifier call: the verdict, or null when it failed, was late or said nothing usable. */
// No `maxTokens`: it caps the thinking and the answer together (`aiGateway.js`), and a 400 cap cut the verdict off
// often enough that about 4 turns in 10 of the 2026-11-07 backfill came back unsorted.
export async function classifyText({ threads, lines, question, replying, group = false, config, metadata, timeZone = null, request = requestViaGateway, timeoutMs = THREADS_TIMEOUT_MS }) {
  if (!config) return null;
  const call = request(
    { model: THREADS_MODEL, system: withArchitecture(THREADS_SYSTEM, "threads"), messages: [{ role: "user", text: threadsMessage({ threads, lines, question, replying, group }) }], tools: [], effort: THREADS_EFFORT },
    config,
    { metadata, timeZone }, // told today in their zone (`localNow.js` `withToday`)
  );
  let timer;
  const reply = await Promise.race([
    Promise.resolve(call).catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return reply === null ? null : readVerdict(reply.text, threads);
}

/** A thread as one listed line. */
function threadLine(thread, when) {
  return `- ${thread.id} · ${thread.status} · ${thread.title}${thread.description ? `: ${thread.description}` : ""} (last ${when(thread.last)})`;
}

/**
 * The history block's threads part: the listed threads, then the suggested thread and its texts older than the
 * last day (`older`, already rendered lines), or that the text starts a new one. "" when there are no threads.
 */
export function threadsPrompt({ threads, suggested = null, fresh = false, older = [], when }) {
  if (threads.length === 0 && suggested === null) return "";
  const listed = listedThreads(threads);
  const hidden = threads.length - listed.length;
  const lines = [
    `Conversations in this chat, open ones first (the texts below are the last 24 hours; read_thread opens any conversation in full${hidden > 0 ? `, including ${hidden} older ones not listed` : ""}):`,
    ...listed.map((thread) => threadLine(thread, when)),
  ];
  if (fresh) lines.push("", "The newest text most likely starts a new conversation.");
  else if (suggested !== null) {
    lines.push("", `The newest text most likely continues ${suggested.id}, "${suggested.title}". It's a guess: go by what they said.`);
    if (older.length > 0) lines.push(`Its texts from before the last 24 hours:`, ...older);
  }
  return lines.join("\n");
}

/** `read_thread`: one thread's texts, or every thread when none is named. */
export function readThreadTool({ threads, render }) {
  return {
    tool: {
      name: "read_thread",
      description:
        "Open a conversation of this chat in full (its texts, oldest first), or list every conversation with no thread named. " +
        "Use it when a text picks up something not in the last 24 hours, or the suggested conversation looks wrong.",
      inputSchema: { type: "object", properties: { thread: { type: "string", description: "The conversation's id, like t3. Leave it out to list them all." } } },
    },
    call: async (args) => {
      const id = typeof args?.thread === "string" ? args.thread.trim() : "";
      if (id === "") {
        if (threads.length === 0) return { content: [{ type: "text", text: "No conversations are kept for this chat yet." }] };
        const all = [...threads].sort((a, b) => b.last - a.last);
        return { content: [{ type: "text", text: all.map((thread) => `- ${thread.id} · ${thread.status} · ${thread.title}: ${thread.description}`).join("\n") }] };
      }
      const thread = threads.find((each) => each.id === id);
      if (!thread) return { content: [{ type: "text", text: `No conversation ${id} in this chat. Call read_thread with no thread to list them.` }], isError: true };
      const text = render(thread.id);
      return { content: [{ type: "text", text: `${thread.id} · ${thread.status} · ${thread.title}: ${thread.description}\n\n${text || "(None of its texts are in the part of the chat read for this turn: tex/history.ledger.json holds the whole chat.)"}` }] };
    },
  };
}

/** Keep a turn's thread entries in its chat's threads ledger. Never throws. */
export async function threadsWrite(store, session, entries) {
  const place = ledgerPlace(session);
  if (place === null || typeof store?.texLedger !== "function" || !Array.isArray(entries) || entries.length === 0) return;
  const writer = ledgerWriter(store.texLedger(place.owner.chat ?? null), threadsChat(place.chat));
  await writer?.write(entries);
}
