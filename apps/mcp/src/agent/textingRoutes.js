/**
 * The texting Worker's small routes beside `/agent`
 * (docs/design/tex-event-log/CONTRACT.md sections 2 and 4). Each is reached
 * with the per-person access token `/agent` takes, resolved the same way
 * (`http/route.js`), and each answers only the texting clients with write
 * scope, as `/agent/steer` does.
 *
 * - `POST /agent/events` `{ conversation: "texts" | { group }, events }` →
 *   `{ written }`: appends to the chat's event log (`log.js`).
 * - `POST /agent/cancel` `{ turn }` → `{ cancelled }`: marks a named turn
 *   cancelled. The turn stops after its current round, or at its end if the
 *   mark landed after its last round, and withdraws the asks it raised
 *   (`turn.js`, `route.js`). `cancelled: false`, with nothing marked, when no
 *   turn of this person's runs under that id, or the running one already made
 *   a call that changed something or went out (`steer.js` `cancelTurn`): the
 *   Worker then queues the text instead.
 * - `POST /agent/stale` `{ asks }` → `{ disarmed }`: ends the named pending
 *   asks of this person (`disarmRecords`). It can only end an ask: a record
 *   is dropped or disarmed, never armed or extended.
 */

import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { disarmRecords, listPending, withdrawPending } from "../tools/approvals.js";
import { appendEvents, EventRefusal } from "./log.js";
import { cancelTurn, handleSteer } from "./steer.js";

const TEXTS_CLIENT_ID = "context_texts";
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
const TURN = /^[A-Za-z0-9_-]{8,64}$/;
const ASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_STALE = 8;

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
    return json({ written: await appendEvents(store, chat, events) });
  } catch (error) {
    if (error instanceof EventRefusal) return invalid(error.field);
    throw error;
  }
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
export async function cancelledTurn(store, session, { ledger, steer, transcript, steps }) {
  await withdrawPending(store, { userId: session.actorUserId, ids: ledger.asked.map((asked) => asked.id) }).catch(() => {});
  if (steer !== null) await steer.clear();
  if (transcript !== null) await transcript.finish({ answer: "", outcome: "cancelled" }).catch(() => {});
  return json({ cancelled: true, answer: "", asked: 0, steps });
}

/** `POST /agent/stale`. */
export async function handleStale(request, store, session) {
  if (!texting(session) || !hasScope(session, SCOPE_WRITE)) return forbidden();
  const asks = (await bodyOf(request))?.asks;
  if (!Array.isArray(asks) || asks.length > MAX_STALE || !asks.every((id) => typeof id === "string" && ASK_ID.test(id))) return invalid("asks");
  const named = new Set(asks);
  // This person's own texted asks only: another person's record is never listed here.
  const entries = (await listPending(store, { userId: session.actorUserId, texting: true })).filter(({ record }) => named.has(record.id));
  const stuck = entries.length === 0 ? 0 : await disarmRecords(store, entries);
  return json({ disarmed: entries.length - stuck });
}

/** The routes `http/route.js` sends here, by path. */
export const TEXTING_ROUTES = new Map([
  ["/agent/steer", handleSteer],
  ["/agent/events", handleEvents],
  ["/agent/cancel", handleCancel],
  ["/agent/stale", handleStale],
]);
