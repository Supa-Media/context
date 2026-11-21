/**
 * The app chat's rows (`agent/appChatRoute.js`): the Context app's own chat with Tex as the page shows it (Dev2,
 * 2026-11-19: "like whatsapp its own thing, but it can see the same history"). The person's ledger (`texts`, in their
 * personal workspace's object) is their one record, texts and app alike, and Tex reads all of it; the page shows only
 * the entries the app chat wrote (`via: "app"`, `ledger.js` `eventEntry`). The chat object's outbox (`GET /app/outbox`)
 * has the events the ledger has not taken yet, and what the app keeps beside them: a text's pictures (`metas`), the
 * person's tapbacks (`taps`), and which texts can still be edited (`handles`). Both places hold the same events, so they
 * are merged by event id, the ledger's copy first.
 *
 * What a row carries is the contract's Row and nothing else: no tokens, and of a turn's steps only its run card (a Tex
 * row's `run`: each step's name, its main argument and the first line of what it found, cut short by `liveSteps.js`). A person's edit and
 * an unsend are folded into the text they change (its words now, `edited`, or `unsent` with none); a tapback onto the
 * text it is on; a line Tex sent to nobody (`from` system) is left out.
 */

import { ledgerFor, ONE_TO_ONE_CHAT } from "./ledger.js";
import { liveStepOf, MAX_LIVE_STEPS } from "./liveSteps.js";
import { objectByName } from "../../../../apps/mcp/src/objectPlace.js";

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
/** A picture id (`packages/tex/worker/appPictures.ts` `APP_PICTURE_ID`). */
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

/** How many of the newest thinking and tool entries one read takes, for the finished turns' run cards. */
export const STEPS_READ = 600;

/**
 * The newest thinking and tool entries of the person's 1:1, oldest first: each answered turn's run card is built from
 * its own (`runCards`). Never the words of a result beyond the card's first line (`liveSteps.js`).
 */
export async function stepEntries(ledgerOf, workspaceId) {
  const ledger = await ledgerOf({ person: workspaceId });
  if (ledger === null || ledger === undefined) return [];
  const read = await ledger.read(ONE_TO_ONE_CHAT, { before: Number.MAX_SAFE_INTEGER, kinds: ["thinking", "tool"], limit: STEPS_READ, jobs: false });
  return [...(read?.entries ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * The finished run card on the first Tex row of each answered turn (mock: "Worked 12s · 5 steps"): `{ secs, steps }`,
 * the turn's thinking and tool calls in order, timed from its first step, and the seconds from the oldest text it
 * covers to its first answer. A turn with no steps kept gets no card.
 */
function runCards(kept, entries) {
  const byTurn = new Map();
  for (const entry of entries) {
    if (typeof entry?.turn !== "string" || (entry.kind !== "thinking" && entry.kind !== "tool")) continue;
    if (!byTurn.has(entry.turn)) byTurn.set(entry.turn, []);
    byTurn.get(entry.turn).push(entry);
  }
  const atOf = new Map(kept.map(({ row }) => [row.id, row.at]));
  const carded = new Set();
  for (const { row, event } of kept) {
    if (row.who !== "tex" || event.turn === null || carded.has(event.turn)) continue;
    carded.add(event.turn);
    const turnSteps = byTurn.get(event.turn) ?? [];
    if (turnSteps.length === 0) continue;
    const first = Math.min(...turnSteps.map((entry) => (Number.isFinite(entry.at) ? entry.at : row.at)));
    const steps = turnSteps.map((entry) => liveStepOf(entry, (Number.isFinite(entry.at) ? entry.at : first) - first)).filter((step) => step !== null).slice(-MAX_LIVE_STEPS);
    if (steps.length === 0) continue;
    const asked = event.covers.map((id) => atOf.get(id)).filter((at) => Number.isFinite(at));
    const from = asked.length > 0 ? Math.min(...asked) : first;
    row.run = { secs: Math.max(1, Math.round((row.at - from) / 1000)), steps };
  }
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
    cards: plain(body?.cards),
    queue: Array.isArray(body?.queue) ? body.queue.filter((item) => typeof item?.ev === "string") : [],
    failed: plain(body?.failed),
    stopped: plain(body?.stopped),
    run: runOf(body?.run),
  };
}

/** The run card the app shows while a turn runs: `{ turn, covers, startedAt, steps }`, or null. */
function runOf(raw) {
  if (raw === null || typeof raw !== "object" || typeof raw.turn !== "string" || !Number.isFinite(raw.startedAt)) return null;
  const steps = Array.isArray(raw.steps) ? raw.steps.filter((step) => step !== null && typeof step === "object" && (step.k === "think" || step.k === "tool")).slice(-40) : [];
  return { turn: raw.turn, covers: Array.isArray(raw.covers) ? raw.covers.filter((id) => typeof id === "string") : [], startedAt: raw.startedAt, steps };
}

/**
 * A short fingerprint of what the outbox shows: its events, the queue's states, the marked texts and the typing mark.
 * The `wait` op holds a read until it changes (`appChatRoute.js`).
 */
export function outboxDigest(outbox, now = Date.now()) {
  const parts = [
    (outbox.events ?? []).map((event) => `${event.id}:${event.kind}:${event.delivered ?? ""}`).join(","),
    (outbox.queue ?? []).map((item) => `${item.ev}:${item.state}`).join(","),
    Object.keys(outbox.failed ?? {}).sort().join(","),
    Object.keys(outbox.stopped ?? {}).sort().join(","),
    Object.entries(outbox.taps ?? {}).map(([on, tap]) => `${on}:${tap?.emoji}`).sort().join(","),
    typingNow(outbox.typingAt ?? null, now) ? "typing" : "",
    outbox.run ? `${outbox.run.turn}:${outbox.run.steps.length}:${outbox.run.steps.at(-1)?.at ?? ""}:${outbox.run.steps.at(-1)?.text?.length ?? ""}` : "",
  ];
  let hash = 2166136261;
  for (const char of parts.join("|")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash.toString(36);
}

/**
 * Where each of the person's texts is, as the page shows under it (mock: Delivered · Read · Answered):
 *  - `failed` (with `failedAt`): Tex could not answer it (`packages/tex/worker/turnWatch.ts`); Try again queues it.
 *  - `stopped`: the person stopped the turn answering it.
 *  - `answered`: a Tex text or tapback covers it.
 *  - `reading`: the turn answering it is running.
 *  - `queued`: waiting while another turn runs (Tex reads it once that step ends); `sent`: waiting, nothing running.
 *  - `read`: out of the queue with no answer of its own (folded into a turn, or one Tex chose to let be).
 */
function deliveryStates(kept, events, { queue = [], failed = {}, stopped = {} }) {
  const covered = new Set(events.filter((event) => whoOf(event) === "tex").flatMap((event) => event.covers));
  const waiting = new Map(queue.map((item) => [item.ev, item.state]));
  const busy = queue.some((item) => item.state === "running");
  for (const { row } of kept) {
    if (row.who !== "me") continue;
    const mark = plain(failed[row.id]);
    if (Number.isFinite(mark.at)) {
      row.state = "failed";
      row.failedAt = mark.at;
    } else if (Number.isFinite(stopped[row.id])) row.state = "stopped";
    else if (covered.has(row.id)) row.state = "answered";
    else if (waiting.get(row.id) === "running") row.state = "reading";
    else if (waiting.has(row.id)) row.state = busy ? "queued" : "sent";
    else row.state = "read";
  }
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
export function buildRows(ledgerEvents, outbox, now = Date.now(), out = {}, steps = []) {
  const { events: outboxEvents = [], metas = {}, taps = {}, handles = {}, queue = [], failed = {}, stopped = {} } = outbox ?? {};
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
  deliveryStates(kept, events, { queue, failed, stopped });
  runCards(kept, steps);
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
