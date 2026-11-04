/**
 * The texting Worker's small routes beside `/agent`
 * (docs/design/tex-event-log/CONTRACT.md sections 2 and 4). Each is reached
 * with the per-person access token `/agent` takes, resolved the same way
 * (`http/route.js`), and each answers only the texting clients with write
 * scope, as `/agent/steer` does.
 *
 * - `POST /agent/events` `{ conversation: "texts" | { group }, events }` →
 *   `{ written }`: checks them at the door (`log.js` `checkEvents`) and
 *   appends them to the chat's ledger (`ledger.js`), its one record. The
 *   bucket's event log is written only for a chat that has no ledger.
 * - `POST /agent/chat` `{ conversation: "texts" | { group }, chat }` →
 *   `{ events }`: the chat's last day from its ledger, as the Worker's events
 *   (`ledgerHistory.js` `dayFromLedger`), oldest first: what the Worker shows
 *   its decision and checks a reaction or a repeat against, so it keeps no
 *   copy of the chat beyond the events it has not posted yet (the owner,
 *   2026-11-02). Empty for a chat with no ledger.
 * - `POST /agent/cancel` `{ turn }` → `{ cancelled }`: marks a named turn
 *   cancelled. The turn stops after its current round, or at its end if the
 *   mark landed after its last round, and withdraws the asks it raised
 *   (`turn.js`, `texEntryPoint.js`). `cancelled: false`, with nothing marked, when no
 *   turn of this person's runs under that id, or the running one already made
 *   a call that changed something or went out (`steer.js` `cancelTurn`): the
 *   Worker then queues the text instead.
 * - `POST /agent/stale` `{ asks }` → `{ disarmed }`: ends the named pending
 *   asks of this person (`disarmRecords`). It can only end an ask: a record
 *   is dropped or disarmed, never armed or extended.
 */

import { eventEntry, ledgerPlace } from "./ledger.js";
import { startBackfill } from "./ledgerBackfill.js";
import { dayFromLedger } from "./ledgerHistory.js";
import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { EVERY_CHAT, disarmRecords, listPending, withdrawPending } from "../tools/approvals.js";
import { appendEvents, checkEvents, EventRefusal } from "./log.js";
import { cancelTurn, handleSteer } from "./steer.js";

const TEXTS_CLIENT_ID = "context_texts";
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
const TURN = /^[A-Za-z0-9_-]{8,64}$/;
const ASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_STALE = 8;
/** As far back as the Worker keeps a chat (`apps/agent/src/events.ts` `KEEP_EVENTS_MS`). */
const CHAT_DAY_MS = 24 * 60 * 60 * 1000;
/** Entries one read asks for: more than a day's texts the Worker would keep (`READ_LIMIT`), as delivery receipts are among them. */
const CHAT_READ = 2_000;

const texting = (session) => session.actorClientId === TEXTS_CLIENT_ID || session.actorClientId === TEXTS_GROUP_CLIENT_ID;
const forbidden = () => json({ error: "forbidden" }, 403);
const invalid = (detail) => json({ error: "invalid_request", error_description: detail }, 400);

async function bodyOf(request) {
  try {
    const body = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** `POST /agent/events`. */
export async function handleEvents(request, store, session) {
  if (!texting(session) || !hasScope(session, SCOPE_WRITE)) return forbidden();
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  const { conversation, events } = body;
  // A person's own chat is their grant's; a group's is the group grant's, and never the other way round.
  const group = conversation !== null && typeof conversation === "object" && !Array.isArray(conversation) ? conversation.group : undefined;
  if (conversation === "texts" ? session.actorClientId !== TEXTS_CLIENT_ID : typeof group !== "string" || session.actorClientId !== TEXTS_GROUP_CLIENT_ID) return invalid("conversation");
  const chat = conversation === "texts" ? (Array.isArray(events) ? events[0]?.chat : undefined) : group;
  try {
    const checked = checkEvents(chat, events);
    // The chat's one record (`ledger.js`), and nothing else: the bucket's event log is no longer written (the owner, 2026-11-02).
    const place = ledgerPlace(session);
    const ledger = place !== null && typeof store?.texLedger === "function" ? store.texLedger(place.owner.chat ?? null) : null;
    if (ledger === null) {
      // A chat with no ledger to hold it: kept in the old log as before, and counted, so the last of these can be found and closed.
      console.log(JSON.stringify({ event: "tex_events_to_log", group: group !== undefined }));
      return json({ written: await appendEvents(store, chat, checked) });
    }
    const written = [...new Set(checked.map((event) => event.id))];
    // Awaited and never swallowed: a refused write answers an error, so the Worker keeps the events and posts them again.
    for (let at = 0; at < checked.length; at += 100) await ledger.append(place.chat, checked.slice(at, at + 100).map(eventEntry));
    startBackfill(store, session, { logChat: chat }); // the chat from before the ledger, a person's or a group's, off this request's answer
    return json({ written });
  } catch (error) {
    if (error instanceof EventRefusal) return invalid(error.field);
    throw error;
  }
}

/** A request's chat: a person's own is their grant's, a group's the group grant's, never the other way round. Null when it names neither. */
function chatOf(session, conversation, chat) {
  const group = conversation !== null && typeof conversation === "object" && !Array.isArray(conversation) ? conversation.group : undefined;
  if (conversation === "texts") return session.actorClientId === TEXTS_CLIENT_ID && typeof chat === "string" ? chat : null;
  return typeof group === "string" && session.actorClientId === TEXTS_GROUP_CLIENT_ID ? group : null;
}

/** `POST /agent/chat`. */
export async function handleChat(request, store, session, now = Date.now()) {
  if (!texting(session) || !hasScope(session, SCOPE_WRITE)) return forbidden();
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  const chat = chatOf(session, body.conversation, body.chat);
  if (chat === null || chat === "" || chat.length > 256) return invalid("conversation");
  const place = ledgerPlace(session);
  const ledger = place !== null && typeof store?.texLedger === "function" ? store.texLedger(place.owner.chat ?? null) : null;
  if (ledger === null) return json({ events: [] });
  // One read, newest first, of the day's texts. Thrown when the ledger can't be read: the Worker then shows what it has, never a chat that looks empty.
  const read = await ledger.read(place.chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["text"], limit: CHAT_READ, since: now - CHAT_DAY_MS });
  const events = dayFromLedger(read?.entries ?? [], chat, []) ?? [];
  return json({ events });
}

/** `POST /agent/cancel`. */
export async function handleCancel(request, store, session) {
  if (!texting(session) || !hasScope(session, SCOPE_WRITE)) return forbidden();
  const turn = (await bodyOf(request))?.turn;
  if (typeof turn !== "string" || !TURN.test(turn)) return invalid("turn");
  return json({ cancelled: await cancelTurn(store, session, turn) });
}

/**
 * A turn the Worker cancelled, as `/agent` answers it: the asks it raised are
 * withdrawn (the person was never told of them, so a later bare "yes" must not
 * reach them), its steered texts and cancel mark are cleared, and nothing is
 * kept as said. `{ cancelled: true, answer: "", asked: 0, steps }`.
 */
export async function cancelledTurn(store, session, { ledger, steer, steps }) {
  await withdrawPending(store, { userId: session.actorUserId, ids: ledger.asked.map((asked) => asked.id) }).catch(() => {});
  if (steer !== null) await steer.clear();
  return json({ cancelled: true, answer: "", asked: 0, steps });
}

/** `POST /agent/stale`. */
export async function handleStale(request, store, session) {
  if (!texting(session) || !hasScope(session, SCOPE_WRITE)) return forbidden();
  const asks = (await bodyOf(request))?.asks;
  if (!Array.isArray(asks) || asks.length > MAX_STALE || !asks.every((id) => typeof id === "string" && ASK_ID.test(id))) return invalid("asks");
  const named = new Set(asks);
  // This person's own texted asks only: another person's record is never listed here.
  const entries = (await listPending(store, { userId: session.actorUserId, texting: true, chat: EVERY_CHAT, ids: asks })).filter(({ record }) => named.has(record.id));
  const stuck = entries.length === 0 ? 0 : await disarmRecords(store, entries);
  return json({ disarmed: entries.length - stuck });
}

/** The routes `http/route.js` sends here, by path. */
export const TEXTING_ROUTES = new Map([
  ["/agent/steer", handleSteer],
  ["/agent/events", handleEvents],
  ["/agent/chat", handleChat],
  ["/agent/cancel", handleCancel],
  ["/agent/stale", handleStale],
]);
