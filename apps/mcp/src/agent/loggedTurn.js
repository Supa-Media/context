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
 * own record of every named turn it finishes, before it answers
 * (`.context/agent/turns/<turn>.json` = `{ clean }`, `recordTurn`), and it
 * fails closed: a Tex event shown is trusted only when its `turn` has a record
 * saying `clean: true`. No turn, no record, an unreadable one or `clean: false`
 * makes the new turn untrusted (`tainted`), as a tainted kept answer does
 * (`historyIsTainted`, which `route.js` still asks of today's history). The
 * Worker's fixed texts are `system` events (`log.js`), never Tex's.
 */

import { conversationPath, readConversation } from "./conversation.js";
import { readGroupMemory } from "./groupTurn.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { EVENT_ID, isChatKey, readEvents } from "./log.js";
import { renderEvents, seenBy, speaker, words } from "./logRender.js";
import { CANCEL_PREFIX, RUNNING_PREFIX } from "./steer.js";

const MAX_COVERS = 32;
const TURN = /^[A-Za-z0-9_-]{8,64}$/;
export const TURNS_PREFIX = ".context/agent/turns/";
/** Older than this, a turn record or a running or cancel mark is pruned: twice the log's 24h window. */
const KEEP_MS = 48 * 3_600_000;
const MAX_PRUNED = 100;

/**
 * Record whether a named turn stayed inside the workspace. Throws when it
 * cannot: no record is untrusted. A record only ever moves toward not clean:
 * `clean: true` is written only where none exists (create-only, and read
 * first for a store that ignores the condition), and `clean: false` always
 * wins. So a caller that reuses a tainted turn's id on a clean exit never
 * launders it, and one that reuses a clean id on a tainted turn taints it.
 * On a store that ignores the condition (B2, Wasabi), the clean record is
 * read back, and a `clean: false` that landed meanwhile is written again.
 * Each call also prunes old records (`pruneTurns`).
 */
export async function recordTurn(store, turn, clean, { now = Date.now() } = {}) {
  if (typeof turn !== "string" || !TURN.test(turn)) return;
  const key = `${TURNS_PREFIX}${turn}.json`;
  const tainted = JSON.stringify({ clean: false });
  if (clean !== true) await store.put(key, tainted);
  else if ((await store.get(key)) === null) {
    await store.put(key, JSON.stringify({ clean: true }), { onlyIf: { absent: true } });
    const back = await store.get(key);
    if (back !== null && JSON.parse(await back.text())?.clean !== true) await store.put(key, tainted);
  }
  // Left over, a record is only kept longer; after the answer where the host allows (a listing and up to 100 reads: about 10 s of a "hi Tex", 2026-10-31).
  const prune = pruneTurns(store, now).catch(() => {});
  if (typeof store.defer === "function") store.defer(prune);
  else await prune;
}

/**
 * Delete `clean: true` turn records and stray running and cancel marks older
 * than 48h, at most 100 a call. One the store cannot date is kept, and so is
 * every `clean: false` record: gone, a reused turn id could record clean over
 * it and launder the events it said.
 */
export async function pruneTurns(store, now = Date.now()) {
  const old = async (prefix) => {
    // lean: first listing page per prefix only, enough while a bucket gains under 1000 a day; page with a cursor past that.
    const page = await store.list({ prefix });
    return (page?.objects ?? []).filter((object) => {
      const at = new Date(object.uploaded ?? 0).getTime();
      return at > 0 && now - at > KEEP_MS;
    }).map((object) => object.key);
  };
  const [turns, running, cancels] = await Promise.all([TURNS_PREFIX, RUNNING_PREFIX, CANCEL_PREFIX].map(old));
  const marks = [...running, ...cancels].slice(0, MAX_PRUNED);
  // lean: kept false records are read again each call, at most 100; skip them by a listing marker if that cost shows.
  const checked = turns.slice(0, MAX_PRUNED - marks.length);
  const clean = await Promise.all(checked.map((key) => cleanTurn(store, key.slice(TURNS_PREFIX.length, -".json".length))));
  await Promise.all([...marks, ...checked.filter((_, i) => clean[i] === true)].map((key) => store.delete(key)));
}

/**
 * Run a turn and record it on every exit (`recordTurn`), before its answer:
 * `run(outcome)` names the turn (`outcome.turn`) and says whether it stayed
 * clean (`outcome.clean`). Only a texted turn the Worker named, as steer
 * takes it (`steer.js` `steerFor`), sets `turn`. A texted yes or no answered
 * with no model is clean; a refusal before any model writes no record (its
 * fixed words are the Worker's `system` event); a turn that threw, or whose
 * `clean` was never set, is not clean.
 */
export async function recordedTurn(store, run) {
  const outcome = { turn: undefined, clean: false };
  try {
    return await run(outcome);
  } finally {
    await recordTurn(store, outcome.turn, outcome.clean === true).catch(() => {});
  }
}

/** A turn's record: `true` clean, `false` recorded not clean, `null` none or unreadable (failed closed). */
async function cleanTurn(store, turn) {
  if (typeof turn !== "string" || !TURN.test(turn)) return null;
  try {
    const object = await store.get(`${TURNS_PREFIX}${turn}.json`);
    const clean = object === null ? undefined : JSON.parse(await object.text())?.clean;
    return typeof clean === "boolean" ? clean : null;
  } catch {
    return null;
  }
}

/** Whether any of Tex's events shown is not proven clean; logs how many had no readable record, by count only. */
async function showsTainted(store, events, workspace, warm = null) {
  const turns = [...new Set(events.filter((event) => event.from?.kind === "tex").map((event) => event.turn))];
  const records = await Promise.all(turns.map((turn) => (warm === null ? cleanTurn(store, turn) : warm.clean(turn, () => cleanTurn(store, turn)))));
  const count = records.filter((clean) => clean === null).length;
  if (count > 0) console.log(JSON.stringify({ event: "tex_turn_unproven", workspace: String(workspace), count }));
  return records.some((clean) => clean !== true);
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
export async function turnHistory(store, session, body, { runner, group, dispatch, warm = null }) {
  const conversation = !runner && group === null && conversationPath(body.conversation) !== null && hasScope(session, SCOPE_WRITE) ? body.conversation : null;
  const read = () => readConversation(store, conversation);
  const history = group !== null ? await readGroupMemory(store, group, dispatch) : conversation === null ? [] : await (warm === null ? read() : warm.history(read)); // from a warm copy when it has the chat (`warmCopy.js`)
  return { conversation, history };
}

/** The log's history and question for a turn that names what it covers, or null for today's turn. */
export async function loggedTurn(store, body, { group = null, timeZone = "UTC", workspace, warm = null } = {}) {
  const covers = body?.covers;
  if (!Array.isArray(covers) || covers.length === 0 || covers.length > MAX_COVERS || !covers.every((id) => typeof id === "string" && EVENT_ID.test(id))) return null;
  if (!isChatKey(body.chat)) return null;
  const events = warm === null ? await readEvents(store, body.chat) : await warm.events(body.chat, () => readEvents(store, body.chat));
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
  return { history: transcript === "" ? [] : [{ role: "user", text: `${LOG_PREFACE}\n\n${transcript}` }], question, tainted: await showsTainted(store, shown, workspace, warm) };
}

/** Today's history and the chat's event log, side by side: what a turn reads before its model (`route.js`). */
export function turnReads(store, session, body, { runner, group, dispatch, warm, timeZone }) {
  return Promise.all([turnHistory(store, session, body, { runner, group, dispatch, warm }), runner ? null : loggedTurn(store, body, { group, timeZone, workspace: session.workspaceId, warm })]);
}
