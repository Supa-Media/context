/**
 * TEX'S WARM COPY (Seyi, 2026-10-31: "how can we completely eliminate storage
 * calls", then "yeah let's do that" to keeping it in the texting Worker's
 * per-person Durable Object).
 *
 * A one-to-one "hi Tex" read the setup through the pinned workspace, the
 * learned skills, About me and the jobs list, today's chat and the chat's event
 * log, every turn record behind it, and the waiting asks, all from storage,
 * before the model ran: about a minute of a turn whose model took 3 seconds.
 *
 * So the gateway hands the texting Worker what it read, sealed, with each
 * answer, and the Worker's per-person object hands it back with the next text.
 * A turn that comes with a copy it can open reads nothing it already has; one
 * that comes without (the first text, a lost or expired copy) reads exactly as
 * before and starts one.
 *
 * - Sealed with AES-GCM under a key derived from `GATEWAY_SECRET`, which the
 *   texting Worker never holds: the Worker keeps bytes it cannot read or
 *   change. The associated data binds the workspace, the person and the
 *   client, so one person's copy never opens on another's turn.
 * - A cache, never a copy of record: the bucket stays where every note, the
 *   chat and the event log live, and a turn writes there as it always did.
 *   Dropping the copy costs one slow turn, never anything kept.
 * - Fresh enough to trust, by part: the setup (a pinned note that changes
 *   rarely) for an hour; what changes outside the chat (learned skills, About
 *   me and the jobs list) for ten minutes, and dropped by any turn that wrote;
 *   the chat for a day, carried forward by
 *   each turn with what it said. The Worker drops the whole copy when it
 *   texts outside a turn (a routine, a job), since the chat then holds words
 *   the copy hasn't seen.
 * - The chat's newest events come from the Worker itself (`recent`), as they
 *   would reach the log through `/agent/events`, on the same grant.
 * - The waiting asks are never kept: a job, a routine or the heartbeat arms one
 *   beside the chat without touching this copy, so every turn that may have one
 *   reads them for itself (`frontDoor.js`).
 *
 * Only a person's own texted turn (not a group, a job, a routine or a report)
 * uses one.
 */

import { decodeBase64, encodeBase64 } from "../crypto/bytes.js";
import { checkEvent, READ_CHARS, READ_LIMIT } from "./log.js";
import { keptTurn, MAX_HISTORY_CHARS, trimHistory } from "./conversation.js";

const LABEL = "context-tex-warm-v1";
/** The texting Worker's client: what a write beside the copy is sealed for. */
const TEXTS_CLIENT = "context_texts";
const PREFIX = "tw1.";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What changes outside the chat (About me, learned skills, the jobs list) is trusted this long, then read again. */
export const WARM_NOTES_MS = 10 * 60 * 1000;
/** The texting setup, a note in the pinned workspace that changes rarely: trusted this long, then read again. */
export const WARM_SETUP_MS = 60 * 60 * 1000;
/** The chat itself, carried forward turn by turn. */
export const WARM_CHAT_MS = 24 * 60 * 60 * 1000;
/** A sealed copy larger than this is not made: the turn after reads, as without one. */
export const WARM_MAX_CHARS = 1_500_000;

async function warmKey(secret, usage) {
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const info = encoder.encode(LABEL);
  const block = new Uint8Array(info.length + 1);
  block.set(info);
  block[info.length] = 1;
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, block));
  return crypto.subtle.importKey("raw", derived, "AES-GCM", false, [usage]);
}

const aad = (session) => encoder.encode(`${LABEL}:${session.workspaceId}:${session.actorUserId}:${session.actorClientId}`);
const secretOf = (env) => (typeof env?.GATEWAY_SECRET === "string" && env.GATEWAY_SECRET.length >= 16 ? env.GATEWAY_SECRET : null);

async function squeeze(bytes, Stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new Stream("gzip"))).arrayBuffer());
}

/** Seal a copy for this session. Null when it can't be made (no key, too large). */
export async function sealWarm(env, session, copy) {
  const secret = secretOf(env);
  if (secret === null) return null;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = await squeeze(encoder.encode(JSON.stringify(copy)), CompressionStream);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(session) }, await warmKey(secret, "encrypt"), plain));
    const joined = new Uint8Array(iv.length + sealed.length);
    joined.set(iv);
    joined.set(sealed, iv.length);
    const text = `${PREFIX}${encodeBase64(joined)}`;
    return text.length <= WARM_MAX_CHARS ? text : null;
  } catch {
    return null;
  }
}

/** What was sealed for this session, or null (none, someone else's, tampered, unreadable). */
async function openSealed(env, session, sealed) {
  const secret = secretOf(env);
  if (secret === null || typeof sealed !== "string" || !sealed.startsWith(PREFIX) || sealed.length > WARM_MAX_CHARS) return null;
  try {
    const joined = decodeBase64(sealed.slice(PREFIX.length));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: joined.subarray(0, 12), additionalData: aad(session) }, await warmKey(secret, "decrypt"), joined.subarray(12));
    const copy = JSON.parse(decoder.decode(await squeeze(new Uint8Array(plain), DecompressionStream)));
    return copy !== null && typeof copy === "object" && copy.v === 1 ? copy : null;
  } catch {
    return null;
  }
}

/** Open a copy for this session: its parts still fresh at `now`, or null (none, someone else's, tampered, unreadable). */
export async function openWarm(env, session, sealed, now = Date.now()) {
  try {
    const copy = await openSealed(env, session, sealed);
    if (copy === null) return null;
    const fresh = (part, ms) => (part && Number.isFinite(part.at) && part.at <= now && now - part.at < ms ? part : undefined);
    return { setup: fresh(copy.setup, WARM_SETUP_MS), skills: fresh(copy.skills, WARM_NOTES_MS), notes: fresh(copy.notes, WARM_NOTES_MS), chat: fresh(copy.chat, WARM_CHAT_MS) };
  } catch {
    return null;
  }
}

/**
 * One turn's use of a copy. Each read takes the work it replaces: with a fresh
 * part it is skipped, without one it runs and what it read is kept for the
 * next copy. `eligible` false (a group, a job, a routine) means it always runs
 * and no copy is made.
 */
export function warmTurn(env, session, body, { eligible, now = Date.now(), writes = () => [] }) {
  const opened = eligible ? openWarm(env, session, body?.warm, now) : Promise.resolve(null);
  // What Tex wrote to this history beside the copy's turns (a routine, a check-in), handed back sealed (`sealBeside`).
  const beside = eligible ? openBeside(env, session, body?.beside) : Promise.resolve([]); // null when one won't open: the copy would be behind, so the history is read whole
  const next = { v: 1 };
  // Every write to the history reaches the copy (this request's, `writes`, and those beside it), so the copy is always the whole history.
  const chatUsable = eligible;
  const cleanSeen = {};
  // A background job writes on its own (task notes, the jobs list, a skill): while one runs, or just after, those are read fresh.
  const jobBusy = (Array.isArray(body?.running) ? body.running : []).some((job) => job?.state === "running" || (Number.isFinite(job?.finishedAt) && now - job.finishedAt < WARM_NOTES_MS));
  const part = (name) => async (read) => {
    const warm = jobBusy && (name === "notes" || name === "skills") ? undefined : (await opened)?.[name];
    if (warm !== undefined && warm.value !== undefined) return (next[name] = warm).value;
    const value = await read();
    if (eligible) next[name] = { at: now, value };
    return value;
  };
  const chat = (async () => {
    const warm = chatUsable ? (await opened)?.chat : undefined;
    const writes = await beside;
    return Array.isArray(warm?.history) && writes !== null ? { ...warm, history: withWrites(warm.history, writes) } : undefined;
  })();
  let chatRead = null, logRead = null;
  return {
    /** The setup's text; the turn parses it either way. */
    setup: part("setup"),
    /** The learned skills' index (`learnedSkills.js`). */
    skills: part("skills"),
    /** About me, the jobs list and who they are (`jobs.js` `readTexNotes`). */
    notes: part("notes"),
    /** Whether the copy holds the history by exchange id: then a write needs nothing read first (`conversation.js` `priorTurns`). */
    logged: async () => (await chat)?.history?.some((turn) => typeof turn.id === "string") === true,
    /** Today's history (`conversation.js` `readConversation`). */
    async history(read) {
      const warm = await chat;
      const history = warm ? withWrites(warm.history, writes()) : await read(); // a read from storage already holds this request's writes
      chatRead = { ...(chatRead ?? {}), history };
      return history;
    },
    /** The chat's event log (`log.js` `readEvents`), with the Worker's newest events on top. */
    async events(chatKey, read) {
      // The Worker holds the chat's whole log (`apps/agent/src/events.ts` `holdsLog`): its events are all of it, nothing is read from storage.
      const held = eligible && body?.holdsLog === true && Array.isArray(body?.recent);
      const warm = held ? undefined : await chat;
      const base = held ? [] : warm?.events ?? (await read());
      const events = mergeEvents(base, eligible ? body?.recent : null, { chat: chatKey, now }); // only the texting Worker's own turn hands events in
      chatRead = { ...(chatRead ?? {}), events };
      if (eligible && !held) logRead = events; // read from storage (or a copy of that read): handed to the Worker to hold from now on
      return events;
    },
    /** The log this turn read from storage, for the Worker to hold so the next turn reads none (`apps/agent/src/events.ts` `keepLog`); null when it read none. */
    log: () => logRead,
    /** Whether a turn record is clean, from the copy when it knows it. */
    async clean(turn, read) {
      const known = (await chat)?.clean?.[turn];
      if (typeof known === "boolean") return known;
      const clean = await read();
      if (typeof clean === "boolean") cleanSeen[turn] = clean;
      return clean;
    },
    /**
     * The copy to hand back: what this turn read, with what it said added.
     * `exchange` the history turns it kept (null when nothing was kept),
     * `keepChat` false when what it kept can't be known here (then the chat is read again),
     * `turn` and `clean` its own record, `wrote` whether it changed anything
     * (then the notes and skills are read again).
     */
    async seal({ exchange = null, keepChat = true, turn = null, clean = null, wrote = false }) {
      if (!eligible) return null;
      const warm = await chat;
      const out = { ...next };
      // A part this turn never asked for (a yes the gateway settled reads none) is carried as it was, still fresh by its own time.
      const was = await opened;
      for (const name of ["setup", "skills", "notes"]) if (out[name] === undefined && was?.[name] !== undefined && !(name !== "setup" && jobBusy)) out[name] = was[name];
      if (wrote) {
        delete out.skills;
        delete out.notes;
      }
      // The history this turn read, or the copy's when it read none (a yes the gateway settled), with everything written since: kept whether or not
      // the turn read the log, since a job's report names no texts and dropping it cost the next text 150 reads (2026-10-31).
      const read = chatRead?.history ?? warm?.history;
      if (keepChat && chatUsable && read !== undefined) {
        const written = withWrites(read, writes());
        const history = exchange === null ? written : trimHistory([...written, ...exchange], { chars: MAX_HISTORY_CHARS });
        // A record only moves toward not clean (`loggedTurn.js` `recordTurn`): a retried turn id's earlier attempt may have recorded false, so its own clean exit is left for the next turn to read.
        const known = { ...(warm?.clean ?? {}), ...cleanSeen, ...(typeof turn === "string" && clean === false ? { [turn]: false } : {}) };
        if (typeof turn === "string" && clean !== false && known[turn] === true) delete known[turn];
        // The log this turn read, or none: a log it didn't read is held by the Worker or read next time, never carried stale.
        const events = chatRead?.events;
        const shown = new Set((events ?? []).map((event) => event.turn).filter(Boolean));
        if (typeof turn === "string") shown.add(turn);
        out.chat = {
          at: warm?.at ?? now,
          history,
          ...(events !== undefined ? { events } : {}),
          clean: Object.fromEntries(Object.entries(known).filter(([id]) => events === undefined || shown.has(id))),
        };
      }
      return await sealWarm(env, session, out);
    },
  };
}

/**
 * The log as the turn reads it: the copy's (or storage's) events with the
 * Worker's newest added, each checked as `/agent/events` checks it, one per id,
 * oldest first, at most what `readEvents` would return.
 */
export function mergeEvents(base, recent, { chat, now }) {
  const byId = new Map();
  for (const event of Array.isArray(base) ? base : []) if (typeof event?.id === "string") byId.set(event.id, event);
  for (const event of Array.isArray(recent) ? recent.slice(-READ_LIMIT) : []) {
    try {
      const checked = checkEvent(event, { chat, now });
      if (!byId.has(checked.id)) byId.set(checked.id, checked);
    } catch {
      // Not one the log would take: left out, as `/agent/events` would refuse it.
    }
  }
  const newestFirst = [...byId.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const kept = [];
  let room = READ_CHARS;
  for (const event of newestFirst) {
    if (kept.length >= READ_LIMIT) break;
    room -= JSON.stringify(event).length;
    if (room < 0) break;
    kept.push(event);
  }
  return kept.reverse();
}

/**
 * One exchange as `readConversation` returns it once written, under the id
 * and time chosen for its write (`events.js` `newExchange`), so the warm copy
 * holds exactly what the next read would.
 */
export function exchangeTurns(question, answer, { at, id, tainted = false, tools = [], sources = [], thread = null, theirs = false }) {
  return [
    keptTurn({ role: "user", text: question, id, at, ...(thread ? { thread } : {}), theirs }),
    keptTurn({ role: "assistant", text: answer, tainted, tools, sources }),
  ];
}

/** The most writes one sealed batch, or one turn, carries beside the copy. */
export const MAX_BESIDE = 20;
const WRITE_ID = /^\d{13}-[a-z0-9]{1,16}$/;

/**
 * What a request that is not the person's own turn (a routine, a check-in)
 * wrote to their texts, sealed for their texting turn alone: the Worker keeps
 * it beside the copy and hands it to the next text, which adds it to the
 * copy's history. Null when nothing was written or it can't be sealed.
 */
export async function sealBeside(env, session, writes) {
  const kept = (Array.isArray(writes) ? writes : []).filter(isWrite).slice(-MAX_BESIDE);
  if (kept.length === 0) return null;
  return await sealWarm(env, { workspaceId: session.workspaceId, actorUserId: session.actorUserId, actorClientId: TEXTS_CLIENT }, { v: 1, beside: kept });
}

/** The writes sealed beside the copy for this texting session, or null when any won't open (or there are more than one text carries): the copy can't be brought up to date. */
export async function openBeside(env, session, sealed) {
  if (sealed === undefined) return [];
  if (!Array.isArray(sealed) || sealed.length > MAX_BESIDE) return null;
  const opened = await Promise.all(sealed.map((one) => openSealed(env, session, one)));
  if (opened.some((copy) => !Array.isArray(copy?.beside))) return null;
  return opened.flatMap((copy) => copy.beside.filter(isWrite));
}

function isWrite(write) {
  return write !== null && typeof write === "object" && typeof write.question === "string" && typeof write.answer === "string" && typeof write.id === "string" && WRITE_ID.test(write.id) && Number.isFinite(write.at);
}

/** A history with writes it lacks added, each by its id, placed by when it happened. */
export function withWrites(history, writes) {
  const known = new Set(history.filter((turn) => typeof turn.id === "string").map((turn) => turn.id));
  const fresh = (Array.isArray(writes) ? writes : []).filter((write) => isWrite(write) && !known.has(write.id) && (known.add(write.id), true));
  if (fresh.length === 0) return history;
  // Exchanges: a question and the turns after it, until the next question.
  const exchanges = [];
  for (const turn of [...history, ...fresh.flatMap((write) => exchangeTurns(write.question, write.answer, write))]) {
    if (turn.role === "user" || exchanges.length === 0) exchanges.push([turn]);
    else exchanges[exchanges.length - 1].push(turn);
  }
  const at = (exchange) => (Number.isFinite(exchange[0].at) ? exchange[0].at : -Infinity);
  const ordered = exchanges.map((exchange, index) => ({ exchange, index })).sort((a, b) => at(a.exchange) - at(b.exchange) || a.index - b.index);
  return trimHistory(ordered.flatMap(({ exchange }) => exchange), { chars: MAX_HISTORY_CHARS });
}
