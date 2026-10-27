/**
 * A chat's event log (docs/design/tex-event-log/CONTRACT.md sections 1 and 2):
 * one object per thing that happened in a chat, appended by the texting
 * Worker, never edited.
 *
 * Kept in the customer's bucket at `.context/agent/log/<sha256(chat)>/<id>.json`:
 * a person's own store for a 1:1 chat, and for a group the store of the one
 * shared workspace its grant is bound to. A group session's `store` already is
 * that workspace's (`groupTurn.js` keeps the chat's memory in the same store),
 * so nothing here resolves a second one.
 *
 * Every event is checked at the door (a trust boundary): closed sets, length
 * caps, an `at` within a day of now and an id that names that `at`. One bad
 * event refuses the whole call. Only the contract's fields are copied into
 * the object written, so nothing else the Worker sends, a tool's result
 * included, is ever kept.
 */

import { sha256Hex } from "../ingestion/inbox.js";
import { TOLD } from "./conversation.js";

export const LOG_PREFIX = ".context/agent/log/";
export const MAX_EVENTS_PER_CALL = 50;
export const MAX_EVENT_TEXT = 3_000;
export const READ_LIMIT = 400;
export const READ_CHARS = 120_000;
const DAY_MS = 86_400_000;
const MAX_COVERS = 32;

export const EVENT_KINDS = new Set(["text", "picture", "file", "link", "reaction", "ask", "ask_settled", "delivery"]);
export const FROM_KINDS = new Set(["person", "tex", "system"]);
export const REASONS = new Set(["upload_failed", "send_refused", "held_newcomer", "failed", "timed_out", "too_long"]);
const FIELDS = new Set(["id", "at", "chat", "from", "kind", "text", "replyTo", "delivered", "reason", "turn", "covers", "people", "told", "ask"]);
const FROM_FIELDS = new Set(["kind", "who", "name"]);

export const EVENT_ID = /^\d{13}-\d{6}$/;
const CHAT = /^[A-Za-z0-9_.:@+=-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TURN = /^[A-Za-z0-9_-]{8,64}$/;
/** The approval record an ask event shows (`tools/approvals.js`): only on `kind: "ask"`. */
const ASK = /^[A-Za-z0-9_-]{8,64}$/;
/** A display handle: letters, digits, space and . _ - ' @, at most 64; never a line break or a control character. */
const NAME = /^[\p{L}\p{N} ._\-'@]{1,64}$/u;
/** Names the rendering gives Tex, the gateway and an unnamed person (`logRender.js` `speaker`), or that read as them: never a person's. */
const RESERVED = new Set(["you", "context", "system", "tex", "them"]);

export class EventRefusal extends Error {
  constructor(field) {
    super(field);
    this.field = field;
  }
}

export function isChatKey(value) {
  return typeof value === "string" && CHAT.test(value);
}

/** Where a chat's log lives in its store. */
export async function logPrefix(chat) {
  return `${LOG_PREFIX}${await sha256Hex(chat)}/`;
}

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.has(key));

/**
 * The event as kept: the contract's fields only, or an `EventRefusal` naming
 * the first field that is wrong (the field's name, never its contents).
 */
export function checkEvent(event, { chat, now }) {
  if (!plainObject(event) || !onlyKeys(event, FIELDS)) throw new EventRefusal("event");
  const { id, at, from } = event;
  if (!Number.isSafeInteger(at) || Math.abs(at - now) > DAY_MS) throw new EventRefusal("at");
  if (typeof id !== "string" || !EVENT_ID.test(id) || Number(id.slice(0, 13)) !== at) throw new EventRefusal("id");
  if (event.chat !== chat) throw new EventRefusal("chat");
  if (!plainObject(from) || !onlyKeys(from, FROM_FIELDS) || !FROM_KINDS.has(from.kind)) throw new EventRefusal("from");
  if (from.who !== undefined && (typeof from.who !== "string" || !HEX64.test(from.who))) throw new EventRefusal("from");
  if (from.name !== undefined && (typeof from.name !== "string" || !NAME.test(from.name) || RESERVED.has(from.name.trim().toLowerCase()))) throw new EventRefusal("from");
  if (!EVENT_KINDS.has(event.kind)) throw new EventRefusal("kind");
  if (event.text !== undefined && (typeof event.text !== "string" || event.text.length > MAX_EVENT_TEXT)) throw new EventRefusal("text");
  if (event.replyTo !== undefined && (typeof event.replyTo !== "string" || !EVENT_ID.test(event.replyTo))) throw new EventRefusal("replyTo");
  if (event.delivered !== undefined && typeof event.delivered !== "boolean") throw new EventRefusal("delivered");
  if (event.reason !== undefined && !REASONS.has(event.reason)) throw new EventRefusal("reason");
  if (event.turn !== undefined && (typeof event.turn !== "string" || !TURN.test(event.turn))) throw new EventRefusal("turn");
  if (event.covers !== undefined && (!Array.isArray(event.covers) || event.covers.length > MAX_COVERS || !event.covers.every((cover) => typeof cover === "string" && EVENT_ID.test(cover)))) throw new EventRefusal("covers");
  if (event.people !== undefined && (typeof event.people !== "string" || !HEX64.test(event.people))) throw new EventRefusal("people");
  // A fixed Worker text is the Worker's, never a turn's: a `system` event only (`loggedTurn.js` trusts Tex events by their turn).
  if (event.told !== undefined && (typeof event.told !== "string" || !Object.hasOwn(TOLD, event.told) || from.kind !== "system")) throw new EventRefusal("told");
  if (event.ask !== undefined && (event.kind !== "ask" || typeof event.ask !== "string" || !ASK.test(event.ask))) throw new EventRefusal("ask");
  const kept = { id, at, chat, from: { kind: from.kind, ...(from.who ? { who: from.who } : {}), ...(from.name ? { name: from.name } : {}) }, kind: event.kind };
  for (const field of ["text", "replyTo", "delivered", "reason", "turn", "covers", "people", "told", "ask"]) {
    if (event[field] !== undefined) kept[field] = event[field];
  }
  return kept;
}

/**
 * Append events to a chat's log. All are checked before any is written; one
 * already kept under its id is left as it was (idempotent by id). Returns the
 * ids now in the log from this call.
 */
export async function appendEvents(store, chat, events, { now = Date.now() } = {}) {
  if (!isChatKey(chat)) throw new EventRefusal("chat");
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_CALL) throw new EventRefusal("events");
  const checked = events.map((event, index) => {
    try {
      return checkEvent(event, { chat, now });
    } catch (error) {
      if (error instanceof EventRefusal) throw new EventRefusal(`events[${index}].${error.field}`);
      throw error;
    }
  });
  const prefix = await logPrefix(chat);
  const written = [];
  for (const event of checked) {
    const key = `${prefix}${event.id}.json`;
    if (!written.includes(event.id) && (await store.get(key)) === null) await store.put(key, JSON.stringify(event));
    if (!written.includes(event.id)) written.push(event.id);
  }
  return written;
}

/**
 * A chat's newest events, at most `limit` of them and `chars` characters,
 * oldest first. Empty when the chat has no log. An object that is not an
 * event is left out.
 */
export async function readEvents(store, chat, { limit = READ_LIMIT, chars = READ_CHARS } = {}) {
  if (!isChatKey(chat)) return [];
  const prefix = await logPrefix(chat);
  const keys = [];
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const listed = await store.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const object of listed?.objects ?? []) keys.push(object.key);
    if (!listed?.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  keys.sort();
  const events = [];
  let room = chars;
  for (const key of keys.reverse()) {
    if (events.length >= limit) break;
    const object = await store.get(key);
    if (!object) continue;
    const text = await object.text();
    room -= text.length;
    if (room < 0) break;
    try {
      const event = JSON.parse(text);
      if (typeof event?.id === "string" && EVENT_ID.test(event.id) && EVENT_KINDS.has(event.kind)) events.push(event);
    } catch {
      // Not an event: left out.
    }
  }
  return events.reverse();
}
