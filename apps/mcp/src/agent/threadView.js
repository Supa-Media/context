/**
 * What a text typed inside an iMessage thread is shown of the conversation:
 * that thread, not whatever was texted last.
 *
 * Every text was shown the same last dozen turns, so a reply under the picnic
 * poster read the photo edit texted after it as its context and answered about
 * that (Dev, 2026-10-19). The texting Worker sends the words of the message
 * the thread started with, or of the message replied to (`quoted.js`); the
 * exchange whose question or answer holds them is the thread's root, and the
 * thread is that exchange and every later one typed under it, each marked
 * with its root's id when it was kept (`events.js`).
 *
 * Words are matched, never trusted: they only pick which of the person's own
 * kept exchanges to show, and a root that cannot be found leaves the turn the
 * whole recent conversation, as before.
 */

import { shownHistory } from "./conversation.js";

/** How much of the root's words is matched; enough to tell two texts apart. */
const PROBE_CHARS = 48;
/** Shorter words than this ("ok", "yes") would match anything. */
const MIN_PROBE_CHARS = 12;

function matchable(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The exchanges in a history: each question with its answer, in order. */
function exchanges(history) {
  const pairs = [];
  for (let i = 0; i < history.length; i += 1) {
    if (history[i].role !== "user") continue;
    const answer = history[i + 1]?.role === "assistant" ? history[i + 1] : null;
    pairs.push({ question: history[i], answer });
  }
  return pairs;
}

/**
 * The thread a text was typed in: `thread`, the id its exchange is kept under
 * (null when its root is not a kept exchange), and `shown`, the turns it reads.
 * `elsewhere` counts the exchanges since the root that are not in the thread.
 */
export function threadView(history, { words = "", start = "", replied = false } = {}, turns) {
  const flat = { thread: null, shown: shownHistory(history, turns), elsewhere: 0 };
  if (!replied) return flat;
  const probe = matchable(start || words).slice(0, PROBE_CHARS).trim();
  if (probe.length < MIN_PROBE_CHARS) return flat;
  const pairs = exchanges(history);
  const root = [...pairs]
    .reverse()
    .find((pair) => typeof pair.question.id === "string" && (matchable(pair.question.text).includes(probe) || matchable(pair.answer?.text ?? "").includes(probe)));
  if (!root) return flat;
  const thread = root.question.thread ?? root.question.id;
  const inThread = (pair) => pair.question.id === thread || pair.question.thread === thread;
  const since = pairs.slice(pairs.indexOf(root));
  const kept = pairs.filter((pair) => inThread(pair) || pair === root);
  const shown = shownHistory(
    kept.flatMap((pair) => (pair.answer ? [pair.question, pair.answer] : [pair.question])),
    turns,
  );
  return { thread, shown, elsewhere: since.filter((pair) => !inThread(pair) && pair !== root).length };
}

/** The line the turn's instructions get when it is shown one thread. */
export function threadPrompt({ thread, elsewhere }) {
  if (thread === null) return "";
  return (
    "\n\nThis text was typed inside an iMessage thread, and the earlier texts above are that thread's only." +
    (elsewhere > 0
      ? ` ${elsewhere} other exchange${elsewhere === 1 ? "" : "s"} went on in the rest of the chat since it started; they are about other things, and earlier_texts reads them if this text needs them.`
      : "")
  );
}
