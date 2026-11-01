/**
 * A conversation's recent turns, kept as one record in the person's Tex
 * Durable Object (`history.js`; the owner, 2026-11-01).
 *
 * The texting assistant (`apps/agent`) answers one text at a time, and a text
 * like "and the second one?" means nothing without the one before it. The
 * history is the workspace's, in the workspace's own Tex object, never in the
 * Worker that relays the texts. Every day's texts are also written, as they
 * happen, into the person's `tex/transcripts/` notes (`transcript.js`), which
 * are exported with everything else.
 *
 * Only the words go in: what the person asked and what was answered. Never a
 * tool's result, which can quote a note the next turn's grant might no longer
 * reach. The next turn re-reads what it needs through its own tools.
 *
 * An answer also keeps the names of the tools it used, and nothing else about
 * them: without them the next turn saw its own earlier answer with no lookup
 * behind it and took it back (staging, 2026-10-10). And the addresses of the
 * web pages it read, never their text: without them "where are you reading
 * from?" had no answer, and Tex took back that it had read anything
 * (owner, 2026-10-22; `sources.js`).
 *
 * Bounded twice, by turns and by characters, because the whole record is read
 * into every turn's prompt.
 */

import { eventKey, idOfKey, newExchange } from "./events.js";
import { appendHistory, readHistory } from "./history.js";
import { NOTE_SOURCE_PREFIX, READ_SOURCE_PREFIX, isNoteSource, isReadSource, sourcesOf } from "./sources.js";

/** The conversations a caller may name. A name is never a path. */
const CONVERSATIONS = {
  texts: ".context/agent/conversations/texts.json",
};

/*
  What is kept, and what a turn is shown of it by default. Bounded by
  characters, not by a count of texts: a count cut the draft email out of the
  thread it was texted in ("send this email now", Dev, 2026-10-20), and the
  owner chose the whole history over a cap that day. A turn is shown
  everything kept up to about twenty thousand tokens; `earlier_texts` reads
  the rest that is kept, and every day's texts are in `tex/transcripts/`.
  A setup's `history:` line can still narrow what a turn is shown.
*/
export const MAX_HISTORY_TURNS = 300;
export const MAX_HISTORY_CHARS = 120_000;
export const SHOWN_HISTORY_TURNS = MAX_HISTORY_TURNS;
export const SHOWN_HISTORY_CHARS = 80_000;

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
    const sources = sourcesOf(history[i].sources);
    used.push({ question, tools, ...(sources.length > 0 ? { sources } : {}) });
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

/** A kept turn as a turn reads it: the words, and only the marks this module writes. */
export function keptTurn({ role, text, tainted, tools, sources, id, at, thread, theirs }) {
  const names = toolNames(tools);
  const read = role === "assistant" ? sourcesOf(sources) : [];
  return {
    role,
    text,
    ...(tainted === true ? { tainted: true } : {}),
    ...(names.length > 0 ? { tools: names } : {}),
    ...(read.length > 0 ? { sources: read } : {}),
    ...(role === "user" && typeof id === "string" ? { id } : {}),
    ...(role === "user" && Number.isFinite(at) ? { at } : {}),
    ...(role === "user" && typeof thread === "string" ? { thread } : {}),
    ...(role === "user" && theirs === true ? { theirs: true } : {}),
  };
}

/** A history as it is kept: each turn shaped by `keptTurn`, within both bounds. */
const keep = (turns) => trimHistory(turns.filter(isTurn).map(keptTurn));
/** How the history record is shaped and bounded, for `history.js` and the move (`agentHomeMove.js`). */
export const HISTORY = Object.freeze({ keep, chars: MAX_HISTORY_CHARS });

/** The newest `entries` exchanges of a history (a question and the turns after it). */
function newestExchanges(turns, entries) {
  if (!Number.isFinite(entries) || entries <= 0) return turns;
  let seen = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === "user" && (seen += 1) === entries) return turns.slice(i);
  }
  return turns;
}

/**
 * Read a conversation: the person's one history record (`history.js`), in
 * one call, or its newest `entries` exchanges when a caller needs only the
 * last few. An unreadable history is an empty conversation: this is a
 * convenience, and a corrupt record must not stop the person getting an
 * answer.
 */
export async function readConversation(store, name, { entries } = {}) {
  if (conversationPath(name) === null) return [];
  try {
    return newestExchanges(keep(await readHistory(store, HISTORY)), entries);
  } catch (error) {
    console.log(JSON.stringify({ event: "tex_history_unread", reason: error?.code ?? error?.name ?? "error" }));
    return [];
  }
}

/** A setup's `history:` value: a whole number 0-300, `undefined` when absent, null when invalid. */
export function readHistoryTurns(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) return null;
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
    "Use it when a text refers to something said before that isn't in front of you (\"like I said\", \"that place\", \"the second one\"). " +
    "Older than that, every day's texts are in tex/transcripts/<date>.md.",
  inputSchema: { type: "object", properties: {} },
};

/**
 * `earlier_texts`'s answer: the conversation's words, oldest first, each line
 * marked with who said it. Only words, the same as the history keeps.
 */
export function earlierTextsResult(history) {
  if (history.length === 0) return { content: [{ type: "text", text: "There are no earlier texts." }] };
  const lines = history.map((turn) => {
    const read = turn.role === "assistant" ? sourcesOf(turn.sources) : [];
    const notes = read.filter(isNoteSource);
    const looked = read.filter(isReadSource);
    const pages = read.filter((source) => !isNoteSource(source) && !isReadSource(source));
    return [
      `${turn.role === "user" ? "They" : "You"}: ${turn.text}`,
      ...(pages.length > 0 ? [`(Web pages you read for this: ${pages.join(", ")})`] : []),
      ...(notes.length > 0 ? [`(Notes you wrote for this: ${notes.map((note) => note.slice(NOTE_SOURCE_PREFIX.length)).join(", ")})`] : []),
      ...(looked.length > 0 ? [`(Notes you read for this: ${looked.map((note) => note.slice(READ_SOURCE_PREFIX.length)).join(", ")})`] : []),
    ].join("\n");
  });
  return { content: [{ type: "text", text: lines.join("\n\n") }] };
}

/** `earlier_texts` for one turn: reading a tainted history taints the turn (`onTainted`). */
export function earlierTextsTool(history, onTainted) {
  return {
    tool: EARLIER_TEXTS_DEFINITION,
    call: async () => {
      if (historyIsTainted(history)) onTainted();
      return earlierTextsResult(history);
    },
  };
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
 * Append one question and its answer to the person's history record
 * (`history.js`). `tainted` marks an answer written by a turn that read from
 * outside the workspace (`historyIsTainted`); it ages out with the turn.
 * `tools` is the names of the tools the answer used, `sources` the addresses
 * of the web pages it read (`sources.js`), `thread` the exchange the question
 * was typed under (`threadView.js`), `theirs` that the person sent the
 * question (a check-in waits for those to go quiet). `at` with `id` (or `tag`)
 * are the exchange's time and id when the caller chose them (`events.js`
 * `newExchange`). Answers the exchange's id. Throws when it can't be kept.
 */
export async function appendConversation(store, name, question, answer, { tainted = false, tools = [], sources = [], thread = null, at = Date.now(), tag = null, id: chosen = null, theirs = false } = {}) {
  if (conversationPath(name) === null) return null;
  const exchange = typeof chosen === "string" ? { at, id: chosen } : tag !== null ? { at, id: idOfKey(eventKey(at, tag)) } : newExchange(at);
  const id = exchange.id;
  await appendHistory(
    store,
    [
      keptTurn({ role: "user", text: question, id, at: exchange.at, ...(thread ? { thread } : {}), theirs }),
      keptTurn({ role: "assistant", text: answer, tainted, tools, sources }),
    ],
    HISTORY,
  );
  return id;
}

/**
 * The person's own words this turn, for the sharing judge (`privacy/judge.js`):
 * what they sent, after the last thing they were told, so a bare "yeah do it"
 * reads as the answer to the question it answers. A routine's words are its
 * own note instead, never the last run's answer (`route.js`).
 */
export function wordsOfTurn(history, question) {
  const lastAnswer = [...history].reverse().find((turn) => turn.role === "assistant")?.text ?? "";
  return `${lastAnswer ? `Assistant: ${lastAnswer.slice(-1_000)}\nPerson: ` : ""}${question}`;
}

/*
  The fixed texts the texting Worker sends with no model (`apps/agent/src/
  told.ts`): setting somebody up, and saying their notes are ready. Named by
  the Worker with the next text, and written here in the gateway's own words,
  never the Worker's and never the link, so the next turn knows what "Done"
  answers (@context-lc tex-bugs, 2026-10-19: "Done with what? I don't have
  anything earlier in this chat").
*/
const TOLD_QUESTION = "(Not a text from them. Context sent this text by itself, with no model.)";
export const TOLD = {
  setup:
    "They texted Context's number and were set up by text: they picked their handle, and their account and personal workspace were made. " +
    "I told them their notes take a couple of minutes to get ready and that I'd text when they were.",
  ready:
    "Your notes are ready. I asked them to connect their personal Gmail, the one they check most, with a link that signs them in " +
    "and opens Connect Gmail; that Gmail becomes their main email on Context. When it connects, Context texts them by itself. " +
    "That is step 1 of the onboarding skill; their next text is most likely about it.",
  ready_late: "Their notes were taking longer than usual to set up, so I told them to text me in a few minutes.",
  gmail_main:
    "Their personal Gmail connected and is now their main email on Context. I told them so, said I'm reading their mail, " +
    "and asked whether they have any other Gmails, like for work or a side project. Their next text most likely answers that.",
  gmail:
    "Their Gmail connected (not as their main email: they already had one, or another Context account holds that address). I said I'm reading " +
    "their mail, and asked whether they have any other Gmails, like for work or a side project. Their next text most likely answers that.",
};
const MAX_TOLD = 5;

/** The fixed texts named in a request, known names only, in order; at most a few. */
export function readTold(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((name) => typeof name === "string" && Object.hasOwn(TOLD, name)).slice(0, MAX_TOLD);
}

/**
 * Write the named fixed texts into a conversation, oldest first, before the
 * turn reads it. Best effort: a history that failed to save costs the turn
 * some context, never its answer.
 */
export async function appendTold(store, name, told) {
  const path = conversationPath(name);
  if (path === null || told.length === 0) return;
  try {
    const at = Date.now();
    for (const [index, key] of told.entries()) {
      await appendConversation(store, name, TOLD_QUESTION, TOLD[key], { at: at + index });
    }
  } catch {
    // See above.
  }
}

/**
 * A routine's text goes in the texting conversation, so a reply to it ("move
 * it to Tuesday") reaches a turn that knows what it answers, under a line
 * saying what it was, the way a check-in's is (`heartbeat.js`). Only a text to
 * its writer alone: that is whose conversation this is. Best effort: the text
 * has already gone.
 */
export async function rememberRoutineText(store, routine, text, tainted) {
  if (Array.isArray(routine.settings.to) && routine.settings.to.length > 0) return;
  const line = `(Not a text from them. Your routine ${routine.path} ran on its schedule and you texted them what follows.)`;
  try {
    await appendConversation(store, "texts", line, text, { tainted });
  } catch {
    // See above.
  }
}
