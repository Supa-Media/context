/**
 * A chat's conversation threads folded from its threads ledger, with no imports: the classifier
 * (`conversationThreads.js`) and the conversations view (`texStore/historyView.js`) both read threads this way, and the
 * view is bundled by Workers (the email Worker among them) that must not pull in the classifier's model calls.
 */

export const THREADS_SUFFIX = ".threads";
/** The most threads the prompt lists; the rest are reached with `read_thread`. */
export const MAX_LISTED = 50;
export const TITLE_CHARS = 60;
export const DESCRIPTION_CHARS = 240;
const THREAD_ID = /^t[1-9][0-9]{0,5}$/;

/**
 * The threads as they stand, from the ledger's `thread` entries (any order): `{threads, start}`. Each thread
 * `{id, title, description, status, texts, at, last}`: the newest entry's words and status, every entry's texts.
 * `start` is when the first entry was written (null with none).
 */
export function foldThreads(entries) {
  const byId = new Map();
  let start = null;
  const sorted = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.kind === "thread" && typeof entry.thread === "string" && THREAD_ID.test(entry.thread) && Number.isSafeInteger(entry.at)).sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
  for (const entry of sorted) {
    start = start === null ? entry.at : Math.min(start, entry.at);
    const was = byId.get(entry.thread) ?? { id: entry.thread, title: "", description: "", status: "open", texts: [], at: entry.at, last: entry.at };
    const texts = Array.isArray(entry.texts) ? entry.texts.filter((id) => typeof id === "string") : [];
    byId.set(entry.thread, {
      ...was,
      title: typeof entry.title === "string" && entry.title.trim() !== "" ? entry.title.trim().slice(0, TITLE_CHARS) : was.title,
      description: typeof entry.description === "string" && entry.description.trim() !== "" ? entry.description.trim().slice(0, DESCRIPTION_CHARS) : was.description,
      status: entry.status === "finished" ? "finished" : entry.status === "open" ? "open" : was.status,
      texts: [...new Set([...was.texts, ...texts])],
      last: texts.length > 0 ? entry.at : was.last,
    });
  }
  return { threads: [...byId.values()], start };
}

/** Which threads the prompt lists: open first, newest first, then the most recently finished, `MAX_LISTED` in all. */
export function listedThreads(threads, max = MAX_LISTED) {
  const open = threads.filter((thread) => thread.status === "open").sort((a, b) => b.last - a.last);
  const finished = threads.filter((thread) => thread.status !== "open").sort((a, b) => b.last - a.last);
  return [...open, ...finished].slice(0, max);
}
