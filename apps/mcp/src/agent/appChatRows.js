/**
 * The app chat's rows (`agent/appChatRoute.js`): the Context app's own chat with Tex as the page shows it (Dev2,
 * 2026-11-19: "like whatsapp its own thing, but it can see the same history"). The person's ledger (`texts`, in their
 * personal workspace's object) is their one record, texts and app alike, and Tex reads all of it; the page shows only
 * the entries the app chat wrote (`via: "app"`, `ledger.js` `eventEntry`). The chat object's outbox (`GET /app/outbox`)
 * has the events the ledger has not taken yet, and what the app keeps beside them: a text's pictures (`metas`), the
 * person's tapbacks (`taps`), and which texts can still be edited (`handles`). Both places hold the same events, so they
 * are merged by event id, the ledger's copy first.
 *
 * What a row carries is the contract's Row and nothing else: no tool arguments, no steps, no tokens. A person's edit and
 * an unsend are folded into the text they change (its words now, `edited`, or `unsent` with none); a tapback onto the
 * text it is on; a line Tex sent to nobody (`from` system) is left out.
 */

import { ledgerFor, ONE_TO_ONE_CHAT } from "./ledger.js";
import { objectByName } from "../objectPlace.js";

/** How many ledger entries one read takes: the newest, which the page then trims to its rows. */
export const LEDGER_READ = 1_000;
/** The rows the page is sent at most: the newest, oldest first. */
export const ROWS_SHOWN = 150;
/** A typing mark this old no longer shows Tex working (the app line sets it on each typing call). */
export const TYPING_MS = 60_000;
/** A text the person can edit or unsend for this long after sending it, as in Messages. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

/** The event kinds a row can be. Anything else (asks, settlements, deliveries) is folded into a row or dropped. */
const ROW_KINDS = new Set(["text", "picture", "file", "link"]);
/** A picture id (`apps/agent/src/appPictures.ts` `APP_PICTURE_ID`). */
const PICTURE_ID = /^[0-9a-f]{32}$/;
/** Tex's picture's address: the id its app line kept it under (`appPictureUrl`). */
const TEX_PICTURE = /^https:\/\/app-chat\.invalid\/pic\/([0-9a-f]{32})\.(?:jpg|png|gif|webp)$/;
/** The tapbacks a row shows: Messages' six. */
export const TAPBACK_EMOJI = new Set(["❤️", "👍", "👎", "😂", "‼️", "❓"]);

/**
 * Reads the person's ledger: the newest `LEDGER_READ` text entries, every line's, oldest first. `ledgerOf` is
 * `ledgerFor`. Only the app's own (`via: "app"`) become rows (`buildRows`); the rest tell an ask the person has since
 * answered, wherever they answered it.
 */
export async function ledgerEntries(ledgerOf, workspaceId) {
  const ledger = await ledgerOf({ person: workspaceId });
  if (ledger === null || ledger === undefined) return [];
  const read = await ledger.read(ONE_TO_ONE_CHAT, { before: Number.MAX_SAFE_INTEGER, kinds: ["text"], limit: LEDGER_READ, jobs: false });
  return [...(read?.entries ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

const plain = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});

/** The chat object's outbox for `chatId`. Throws when the object cannot answer. */
export async function outboxOf(namespace, chatId) {
  if (namespace === undefined || namespace === null) throw new Error("no chat home");
  const answer = await objectByName(namespace, `chat:${chatId}`).fetch(new Request("https://chat/app/outbox"));
  if (!answer.ok) throw new Error(`outbox ${answer.status}`);
  const body = await answer.json();
  return {
    events: Array.isArray(body?.events) ? body.events : [],
    typingAt: typeof body?.typingAt === "number" ? body.typingAt : null,
    metas: plain(body?.metas),
    taps: plain(body?.taps),
    handles: plain(body?.handles),
  };
}

/** A ledger entry as an event: the ledger keeps the chat event's kind as `event` and its id as `eid`. */
function fromLedger(entry) {
  if (entry?.kind !== "text" || typeof entry.event !== "string" || typeof entry.eid !== "string") return null;
  return { ...eventOf(entry, entry.eid, entry.event), app: entry.via === "app" };
}

/** An outbox event: the same fields the ledger entry has, under the event's own names. */
function fromOutbox(event) {
  if (typeof event?.id !== "string" || typeof event.kind !== "string") return null;
  return { ...eventOf(event, event.id, event.kind), app: true };
}

function eventOf(raw, id, kind) {
  return {
    id,
    kind,
    at: Number.isFinite(raw.at) ? raw.at : 0,
    from: raw.from ?? null,
    text: typeof raw.text === "string" ? raw.text : "",
    replyTo: typeof raw.replyTo === "string" ? raw.replyTo : null,
    quoted: typeof raw.quoted === "string" ? raw.quoted : null,
    ask: typeof raw.ask === "string" ? raw.ask : null,
    turn: typeof raw.turn === "string" ? raw.turn : null,
    source: typeof raw.source === "string" ? raw.source : null,
    delivered: typeof raw.delivered === "boolean" ? raw.delivered : null,
    covers: Array.isArray(raw.covers) ? raw.covers.filter((cover) => typeof cover === "string") : [],
    edited: raw.edited === true,
    unsent: raw.unsent === true,
  };
}

const whoOf = (event) => (event.from?.kind === "person" ? "me" : event.from?.kind === "tex" ? "tex" : null);

/** The pictures a row shows: Tex's by its address, the person's by the ids the app kept beside the event. */
function picturesOf(event, who, metas) {
  if (who === "tex") {
    const match = TEX_PICTURE.exec(event.text.trim());
    return match ? [match[1]] : [];
  }
  const pics = plain(metas[event.id]).pics;
  return Array.isArray(pics) ? pics.filter((id) => typeof id === "string" && PICTURE_ID.test(id)) : [];
}

/** The Row for an event a page shows, or null for one it does not (an edit, an unsend, a tapback, a system line, an ask). */
function rowOf(event, metas) {
  const who = whoOf(event);
  if (!event.app || who === null || !ROW_KINDS.has(event.kind) || event.edited || event.unsent) return null;
  const pics = event.kind === "picture" ? picturesOf(event, who, metas) : [];
  // Tex's picture's words are only its address: the picture is the row.
  const text = who === "tex" && pics.length > 0 ? "" : event.text;
  const row = { id: event.id, who, text, at: event.at, kind: event.kind };
  if (pics.length > 0) row.pics = pics;
  // The row it replies to: the app's own note of it first (a picture has no words to find it by), else the event's.
  const repliedOn = typeof plain(metas[event.id]).replyTo === "string" ? plain(metas[event.id]).replyTo : event.replyTo;
  if (repliedOn !== null) row.replyTo = { id: repliedOn, ...(event.quoted !== null ? { text: event.quoted.slice(0, 300) } : {}) };
  if (who === "tex" && event.source !== null) row.source = event.source;
  if (event.delivered !== null) row.delivered = event.delivered;
  return row;
}

const byTime = (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The chat's rows, all of them, oldest first. `ledgerEvents` are the ledger's entries; `outbox` is `outboxOf`'s answer
 * (an event in both is taken once); `now` decides which of the person's texts can still be edited; `out.handles` is
 * set to the handle each row is known by to the chat object.
 *
 *  - An edit sets the words of the text it names (`replyTo`) and marks it `edited`; an unsend empties it, marks it
 *    `unsent` and drops its pictures.
 *  - The person's tapback is the last one the app kept on that text (`taps`); Tex's is on the last of the person's
 *    texts it covers.
 *  - A Tex text carries `ask` when an approval was asked on it: the last Tex text of its turn, open until the person
 *    says or taps anything after it (on any line), or an `ask_settled` for its record exists.
 *  - A text the person can still take back (theirs, not unsent, within `EDIT_WINDOW_MS`, and one the chat object still
 *    knows the handle of) is `unsendable`, and also `editable` when it is words with no pictures.
 */
export function buildRows(ledgerEvents, outbox, now = Date.now(), out = {}) {
  const { events: outboxEvents = [], metas = {}, taps = {}, handles = {} } = outbox ?? {};
  const byId = new Map();
  for (const entry of ledgerEvents) {
    const event = fromLedger(entry);
    if (event !== null && !byId.has(event.id)) byId.set(event.id, event);
  }
  for (const raw of outboxEvents) {
    const event = fromOutbox(raw);
    if (event !== null && !byId.has(event.id)) byId.set(event.id, event);
  }
  const events = [...byId.values()].sort(byTime);
  const settled = new Set(events.filter((event) => event.kind === "ask_settled" && event.ask !== null).map((event) => event.ask));
  const kept = [];
  const rowById = new Map();
  for (const event of events) {
    const row = rowOf(event, metas);
    if (row === null) continue;
    kept.push({ row, event });
    rowById.set(row.id, row);
  }
  // Each edit names the text it changes, or an earlier edit of it (the chat object then knows the text's handle by the
  // edit's event): followed back to the row, which carries the newest words and stays editable by that handle.
  const editOf = new Map();
  const editable = { ...handles };
  for (const event of events) {
    if (!event.app || whoOf(event) !== "me" || event.replyTo === null || !(event.edited || event.unsent)) continue;
    const on = rowById.has(event.replyTo) ? event.replyTo : editOf.get(event.replyTo);
    const target = on === undefined ? undefined : rowById.get(on);
    if (target === undefined || target.who !== "me") continue;
    editOf.set(event.id, on);
    if (typeof handles[event.id] === "string") editable[on] = handles[event.id];
    if (event.unsent) {
      target.unsent = true;
      target.text = "";
      delete target.pics;
      delete target.edited;
    } else if (!target.unsent) {
      target.text = event.text;
      target.edited = true;
    }
  }
  // An edit the edit node found to change nothing is logged nowhere; the app kept its words beside the row.
  for (const [id, meta] of Object.entries(metas)) {
    const target = rowById.get(id);
    if (target !== undefined && target.who === "me" && !target.unsent && !target.edited && typeof plain(meta).text === "string") {
      target.text = plain(meta).text;
      target.edited = true;
    }
  }
  for (const [on, tap] of Object.entries(taps)) {
    const target = rowById.get(on);
    if (target !== undefined && !target.unsent && TAPBACK_EMOJI.has(tap?.emoji)) target.reactions = [{ who: "me", emoji: tap.emoji }];
  }
  for (const event of events) {
    if (whoOf(event) !== "tex" || event.kind !== "reaction" || !/^\p{Extended_Pictographic}/u.test(event.text.trim())) continue;
    const target = [...event.covers].reverse().map((id) => rowById.get(id)).find((row) => row !== undefined && row.who === "me" && !row.unsent);
    if (target !== undefined) target.reactions = [...(target.reactions ?? []).filter((reaction) => reaction.who !== "tex"), { who: "tex", emoji: event.text.trim().slice(0, 8) }];
  }
  for (const event of events) {
    if (event.kind !== "ask" || event.ask === null) continue;
    const target = askTarget(kept, event);
    if (target === null) continue;
    // An ask waits for the person's next word: once they said anything after it, on any line, or tapped the text that
    // asks, the gateway has taken that as their answer (`textedApprovals.js`), and the buttons go.
    const answered = settled.has(event.ask) || (target.row.reactions ?? []).some((reaction) => reaction.who === "me") || events.some((later) => later.at > event.at && whoOf(later) === "me");
    target.row.ask = { id: event.ask, open: !answered };
  }
  for (const { row } of kept) {
    const fresh = now - row.at < EDIT_WINDOW_MS;
    if (row.who !== "me" || row.unsent || !fresh || typeof editable[row.id] !== "string") continue;
    // Any of the person's own can be taken back; only words can be edited, as in Messages.
    row.unsendable = true;
    if (row.kind !== "picture" && row.text.trim() !== "") row.editable = true;
  }
  // The handle each row is known by to the chat object, an edited one's included, for an edit or unsend to name.
  out.handles = editable;
  return kept.map(({ row }) => row);
}

/** The Tex text an ask belongs to: the last one of its turn, or the last one before the ask when it names no turn. */
function askTarget(kept, ask) {
  const texts = kept.filter(({ row }) => row.who === "tex" && row.kind === "text");
  if (ask.turn !== null) return texts.filter(({ event }) => event.turn === ask.turn).at(-1) ?? null;
  return texts.filter(({ row }) => row.at <= ask.at).at(-1) ?? null;
}

/** Whether the app line showed typing recently enough for the page to say Tex is working. */
export function typingNow(typingAt, now) {
  return typingAt !== null && now - typingAt < TYPING_MS;
}
