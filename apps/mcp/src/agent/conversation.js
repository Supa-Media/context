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

export const MAX_HISTORY_TURNS = 12;
export const MAX_HISTORY_CHARS = 12_000;

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

/** Every tool the earlier answers in this history used, once each. */
export function usedTools(history) {
  return [...new Set(history.flatMap((turn) => toolNames(turn.tools)))];
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
export function trimHistory(turns) {
  const kept = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && kept.length < MAX_HISTORY_TURNS; i -= 1) {
    chars += turns[i].text.length;
    if (chars > MAX_HISTORY_CHARS) break;
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
