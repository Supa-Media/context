/**
 * What a texted turn is shown of its chat.
 *
 * Today's history (`conversation.js`, a group's memory in `groupTurn.js`) is
 * still read and still written by every turn, so reverting the event log
 * loses nothing. When the Worker names the inbound events a turn answers
 * (`covers`, docs/design/tex-event-log/CONTRACT.md) and its `chat`, and that
 * chat's log (`log.js`) holds all of them, the model is shown the rendered log
 * (`logRender.js`) as its conversation instead, and asked the covered events'
 * words. Every guard (the browser's addresses, the Mail checker, the sharing
 * judge, a texted yes) still reads the request's `question` and today's
 * history, never this. An old chat with no log, or a request naming events
 * not yet logged, is today's turn.
 *
 * A turn that read from outside the workspace taints what it said. The log's
 * events are the Worker's, so the Worker can never say an answer was clean:
 * `tainted` is not an Event field (`log.js` refuses it). The gateway keeps its
 * own record instead, by the turn's id (`.context/agent/tainted/<turn>.json`,
 * `markTainted`), and a turn shown a Tex event from a tainted turn is
 * untrusted (`tainted`), as one shown a tainted kept answer is
 * (`historyIsTainted`, which `route.js` still asks of today's history).
 */

import { conversationPath, readConversation } from "./conversation.js";
import { readGroupMemory } from "./groupTurn.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { EVENT_ID, isChatKey, readEvents } from "./log.js";
import { renderEvents, seenBy, speaker, words } from "./logRender.js";

const MAX_COVERS = 32;
const TURN = /^[A-Za-z0-9_-]{8,64}$/;
export const TAINTED_PREFIX = ".context/agent/tainted/";

/** Record that a named turn read from outside the workspace. */
export async function markTainted(store, turn) {
  if (typeof turn !== "string" || !TURN.test(turn)) return;
  await store.put(`${TAINTED_PREFIX}${turn}.json`, JSON.stringify({ at: Date.now() }));
}

/** Whether any of Tex's events shown came from a turn recorded as tainted. Unreadable is tainted. */
async function showsTainted(store, events) {
  const turns = new Set(events.filter((event) => event.from?.kind === "tex" && typeof event.turn === "string").map((event) => event.turn));
  try {
    for (const turn of turns) if ((await store.get(`${TAINTED_PREFIX}${turn}.json`)) !== null) return true;
    return false;
  } catch {
    return true;
  }
}
export const LOG_PREFACE = "(The chat so far, oldest first, as it happened. \"You\" is you. The newest messages, the ones you are answering, come next.)";

/*
  A named conversation carries its recent turns into this one. Only a name
  from `conversation.js`'s fixed list, never a path, and only on a grant that
  can write: the history is a file in the bucket, and a read-only grant writes
  nothing, so it gets a turn with no memory rather than a write it does not
  hold. Kept in the default context, the one this grant was approved against.
  A group chat remembers in its own file, never the tagger's texts; its turns
  are other people's words, so untrusted (`groupTurn.js`).
*/
export async function turnHistory(store, session, body, { runner, group, dispatch }) {
  const conversation = !runner && group === null && conversationPath(body.conversation) !== null && hasScope(session, SCOPE_WRITE) ? body.conversation : null;
  const history = group !== null ? await readGroupMemory(store, group, dispatch) : conversation === null ? [] : await readConversation(store, conversation);
  return { conversation, history };
}

/** The log's history and question for a turn that names what it covers, or null for today's turn. */
export async function loggedTurn(store, body, { group = null, timeZone = "UTC" } = {}) {
  const covers = body?.covers;
  if (!Array.isArray(covers) || covers.length === 0 || covers.length > MAX_COVERS || !covers.every((id) => typeof id === "string" && EVENT_ID.test(id))) return null;
  if (!isChatKey(body.chat)) return null;
  const events = await readEvents(store, body.chat);
  const wanted = new Set(covers);
  const covered = events.filter((event) => wanted.has(event.id));
  if (covered.length !== wanted.size) return null;
  const question = covered
    .filter((event) => event.from?.kind === "person")
    .map((event) => (group !== null ? `${speaker(event.from)}: ${words(event)}` : words(event)))
    .join("\n");
  if (question === "") return null;
  const shown = seenBy(events.filter((event) => !wanted.has(event.id)), group?.members ?? null);
  const transcript = renderEvents(shown, { timeZone, answeredBy: events });
  return { history: transcript === "" ? [] : [{ role: "user", text: `${LOG_PREFACE}\n\n${transcript}` }], question, tainted: await showsTainted(store, shown) };
}
