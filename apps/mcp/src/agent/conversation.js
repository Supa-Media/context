/**
 * A conversation's recent turns, kept in the customer's own bucket.
 *
 * The texting assistant (`apps/agent`) answers one text at a time, and a text
 * like "and the second one?" means nothing without the one before it. The
 * history lives here, at a plumbing path in the person's bucket, rather than in
 * the Worker that relays the texts: that Worker is ours, and non-negotiable #1
 * puts customer text in the customer's storage. It is exported with everything
 * else, and on a managed bucket it is sealed at rest like any other object.
 *
 * Only the words go in: what the person asked and what was answered. Never a
 * tool's result, which can quote a note the next turn's grant might no longer
 * reach. The next turn re-reads what it needs through its own tools.
 *
 * An answer also keeps the names of the tools it used, and nothing else about
 * them: without them the next turn saw its own earlier answer with no lookup
 * behind it and took it back (staging, 2026-10-10).
 *
 * Bounded twice, by turns and by characters, because the whole file is read
 * into every turn's prompt.
 */

import { getWithLegacyFallback } from "../storageLayout.js";

/** The conversations a caller may name. A name is never a path. */
const CONVERSATIONS = {
  texts: ".context/agent/conversations/texts.json",
};

/*
  What the file keeps, and what a turn is shown of it by default. Kept longer
  than shown (the owner, 2026-10-14: "we should still keep running history",
  without "all of that bloat" on every text): a setup's `history:` line says
  how much a turn sees, and `earlier_texts` reads the rest when a text needs it.
*/
export const MAX_HISTORY_TURNS = 40;
export const MAX_HISTORY_CHARS = 40_000;
export const SHOWN_HISTORY_TURNS = 12;
export const SHOWN_HISTORY_CHARS = 12_000;

export const EARLIER_TEXTS = "earlier_texts";

/** A tool's name as the history keeps it: a name, never a path or a sentence. */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_TOOL_NAMES = 12;
/** Said to the person, not used to find anything, so not worth remembering. */
const UNREMARKABLE = new Set(["text_progress"]);

function toolNames(value) {
  if (!Array.isArray(value)) return [];
  const names = value.filter((name) => typeof name === "string" && TOOL_NAME.test(name) && !UNREMARKABLE.has(name));
  return [...new Set(names)].slice(0, MAX_TOOL_NAMES);
}

/** How much of a question names it in the prompt: enough to tell which, never the whole text again. */
const QUESTION_EXCERPT = 60;

/**
 * For each earlier answer that used tools, the question it answered (a short
 * excerpt of the person's own words, already in the history) and the tools'
 * names, oldest first. Per answer rather than pooled: "you used browse" for
 * the whole conversation did not stop the model taking back the one answer
 * the browser was for (staging, 2026-10-10).
 */
export function usedTools(history) {
  const used = [];
  for (let i = 1; i < history.length; i += 1) {
    const tools = history[i].role === "assistant" ? toolNames(history[i].tools) : [];
    if (tools.length === 0 || history[i - 1].role !== "user") continue;
    const words = history[i - 1].text.replace(/\s+/g, " ").replace(/"/g, "'").trim();
    const question = words.length > QUESTION_EXCERPT ? `${words.slice(0, QUESTION_EXCERPT - 1)}…` : words;
    used.push({ question, tools });
  }
  return used;
}

/** The path for a named conversation, or null for any other name. */
export function conversationPath(name) {
  return typeof name === "string" && Object.hasOwn(CONVERSATIONS, name) ? CONVERSATIONS[name] : null;
}

function isTurn(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string"
  );
}

/** Keep the newest turns that fit both bounds, oldest first. */
export function trimHistory(turns, { turns: most = MAX_HISTORY_TURNS, chars: room = MAX_HISTORY_CHARS } = {}) {
  const kept = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && kept.length < most; i -= 1) {
    chars += turns[i].text.length;
    if (chars > room) break;
    kept.unshift(turns[i]);
  }
  // A history that starts with an answer has lost its question.
  while (kept.length > 0 && kept[0].role !== "user") kept.shift();
  return kept;
}

/**
 * Read a conversation. An absent or unreadable file is an empty conversation:
 * this is a convenience, and a corrupt file must not stop the person getting
 * an answer.
 */
export async function readConversation(store, name) {
  const path = conversationPath(name);
  if (path === null) return [];
  try {
    const object = await getWithLegacyFallback(store, path);
    if (!object) return [];
    const parsed = JSON.parse(await object.text());
    const turns = Array.isArray(parsed?.turns) ? parsed.turns.filter(isTurn) : [];
    return trimHistory(
      turns.map(({ role, text, tainted, tools }) => {
        const names = toolNames(tools);
        return { role, text, ...(tainted === true ? { tainted: true } : {}), ...(names.length > 0 ? { tools: names } : {}) };
      }),
    );
  } catch {
    return [];
  }
}

/** A setup's `history:` value: a whole number 0-40, `undefined` when absent, null when invalid. */
export function readHistoryTurns(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{1,2}$/.test(value)) return null;
  const turns = Number(value);
  return turns <= MAX_HISTORY_TURNS ? turns : null;
}

/** The part of a conversation a turn is shown: the newest `turns`, within the shown characters. */
export function shownHistory(history, turns = SHOWN_HISTORY_TURNS) {
  return turns === 0 ? [] : trimHistory(history, { turns, chars: SHOWN_HISTORY_CHARS });
}

export const EARLIER_TEXTS_DEFINITION = {
  name: EARLIER_TEXTS,
  description:
    "Read your earlier texts with this person, oldest first: what they said and what you answered. " +
    "Use it when a text refers to something said before that isn't in front of you (\"like I said\", \"that place\", \"the second one\").",
  inputSchema: { type: "object", properties: {} },
};

/**
 * `earlier_texts`'s answer: the conversation's words, oldest first, each line
 * marked with who said it. Only words, the same as the history keeps.
 */
export function earlierTextsResult(history) {
  if (history.length === 0) return { content: [{ type: "text", text: "There are no earlier texts." }] };
  const lines = history.map((turn) => `${turn.role === "user" ? "They" : "You"}: ${turn.text}`);
  return { content: [{ type: "text", text: lines.join("\n\n") }] };
}

/**
 * Whether anything still in this history was written after the turn read
 * something from outside the workspace. The next turn's own ledger starts
 * empty, but the model it opens reads this history, and an answer that
 * repeated a planted instruction is that instruction, one text later.
 */
export function historyIsTainted(history) {
  return history.some((turn) => turn.tainted === true);
}

/**
 * Append one question and its answer, keeping the file within bounds.
 * `tainted` marks an answer written by a turn that read from outside the
 * workspace (`historyIsTainted`); it ages out with the turn. `tools` is the
 * names of the tools the answer used.
 */
export async function appendConversation(store, name, history, question, answer, { tainted = false, tools = [] } = {}) {
  const path = conversationPath(name);
  if (path === null) return;
  const names = toolNames(tools);
  const turns = trimHistory([
    ...history,
    { role: "user", text: question },
    { role: "assistant", text: answer, ...(tainted ? { tainted: true } : {}), ...(names.length > 0 ? { tools: names } : {}) },
  ]);
  await store.put(path, JSON.stringify({ version: 1, turns }));
}
