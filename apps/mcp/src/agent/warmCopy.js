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
 * - A cache, never a copy of record: dropping it costs one slow turn, never
 *   anything kept.
 * - Fresh enough to trust, by part: the setup (a pinned note that changes
 *   rarely) for an hour; the learned skills and who they are by their
 *   account for ten minutes, the skills dropped by any turn that wrote; the
 *   chat's event log and its turns' clean marks for a day.
 * - Never the history, About me or the jobs list (the owner, 2026-11-01: "ONE
 *   copy only", no second copy anywhere). They are read with one call to the
 *   person's own Tex Durable Object (`history.js`, `texDesk.js`), so no copy
 *   here can be behind them. `test/texHistoryOneCopy.test.mjs` fails if one
 *   comes back.
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

const LABEL = "context-tex-warm-v1";
const PREFIX = "tw1.";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The learned skills and their account's identity, which change outside the chat: trusted this long, then read again. */
export const WARM_NOTES_MS = 10 * 60 * 1000;
/** The texting setup, a note in the pinned workspace that changes rarely: trusted this long, then read again. */
export const WARM_SETUP_MS = 60 * 60 * 1000;
/** The chat's event log and clean marks, carried forward turn by turn. */
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
    const chat = fresh(copy.chat, WARM_CHAT_MS);
    // Only the parts named here: a copy sealed before 2026-11-01 carried the history and About me, and neither is ever used again.
    return { setup: fresh(copy.setup, WARM_SETUP_MS), skills: fresh(copy.skills, WARM_NOTES_MS), identity: fresh(copy.identity, WARM_NOTES_MS), chat: chat && { at: chat.at, ...(Array.isArray(chat.events) ? { events: chat.events } : {}), ...(chat.clean && typeof chat.clean === "object" ? { clean: chat.clean } : {}) } };
  } catch {
    return null;
  }
}

/**
 * One turn's use of a copy. Each read takes the work it replaces: with a fresh
 * part it is skipped, without one it runs and what it read is kept for the
 * next copy. `eligible` false (a group, a job, a routine) means it always runs
 * and no copy is made.
 *
 * `logEligible`: a group chat's own turn from the texting Worker. It makes no
 * copy, but the chat's event log is held by the group's object just as a
 * one-to-one chat's is (`apps/agent/src/events.ts` `holdsLog`): the first turn
 * reads it from storage and hands it back as `log`, and later turns read none
 * (production, 2026-10-31: every group turn read 275 log files, 4 to 6 s,
 * before the model).
 */
export function warmTurn(env, session, body, { eligible, logEligible = false, now = Date.now() }) {
  const opened = eligible ? openWarm(env, session, body?.warm, now) : Promise.resolve(null);
  const next = { v: 1 };
  const cleanSeen = {};
  // A background job writes on its own (task notes, the jobs list, a skill): while one runs, or just after, those are read fresh.
  const jobBusy = (Array.isArray(body?.running) ? body.running : []).some((job) => job?.state === "running" || (Number.isFinite(job?.finishedAt) && now - job.finishedAt < WARM_NOTES_MS));
  const part = (name) => async (read) => {
    const warm = jobBusy && name === "skills" ? undefined : (await opened)?.[name];
    if (warm !== undefined && warm.value !== undefined) return (next[name] = warm).value;
    const value = await read();
    if (eligible) next[name] = { at: now, value };
    return value;
  };
  const chat = (async () => (eligible ? (await opened)?.chat : undefined))();
  let chatRead = null, logRead = null;
  return {
    /** The setup's text; the turn parses it either way. */
    setup: part("setup"),
    /** The learned skills' index (`learnedSkills.js`). */
    skills: part("skills"),
    /** Who they are by their account (`identity.js`): the control plane's answer, never a note. */
    identity: part("identity"),
    /** The chat's event log (`log.js` `readEvents`), with the Worker's newest events on top. */
    async events(chatKey, read) {
      // The Worker holds the chat's whole log (`apps/agent/src/events.ts` `holdsLog`): its events are all of it, nothing is read from storage.
      const logs = eligible || logEligible; // the texting Worker's own turn, one to one or a group's
      const held = logs && body?.holdsLog === true && Array.isArray(body?.recent);
      const warm = held ? undefined : await chat;
      const base = held ? [] : warm?.events ?? (await read());
      const events = mergeEvents(base, logs ? body?.recent : null, { chat: chatKey, now }); // only the texting Worker's own turn hands events in
      chatRead = { events };
      if (logs && !held) logRead = events; // read from storage (or a copy of that read): handed to the Worker to hold from now on
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
     * The copy to hand back: what this turn read. `turn` and `clean` its own
     * record, `wrote` whether it changed anything (then the notes and skills
     * are read again).
     */
    async seal({ turn = null, clean = null, wrote = false } = {}) {
      if (!eligible) return null;
      const warm = await chat;
      const out = { ...next };
      // A part this turn never asked for (a yes the gateway settled reads none) is carried as it was, still fresh by its own time.
      const was = await opened;
      for (const name of ["setup", "skills", "identity"]) if (out[name] === undefined && was?.[name] !== undefined && !(name !== "setup" && jobBusy)) out[name] = was[name];
      if (wrote) delete out.skills;
      // A record only moves toward not clean (`loggedTurn.js` `recordTurn`): a retried turn id's earlier attempt may have recorded false, so its own clean exit is left for the next turn to read.
      const known = { ...(warm?.clean ?? {}), ...cleanSeen, ...(typeof turn === "string" && clean === false ? { [turn]: false } : {}) };
      if (typeof turn === "string" && clean !== false && known[turn] === true) delete known[turn];
      // The log this turn read, or the copy's when it read none (a yes the gateway settled); a log the Worker holds is never carried.
      const events = chatRead?.events ?? warm?.events;
      const shown = new Set((events ?? []).map((event) => event.turn).filter(Boolean));
      if (typeof turn === "string") shown.add(turn);
      out.chat = {
        at: warm?.at ?? now,
        ...(events !== undefined ? { events } : {}),
        clean: Object.fromEntries(Object.entries(known).filter(([id]) => events === undefined || shown.has(id))),
      };
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
