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
 *   account for ten minutes, the skills dropped by any turn that wrote; its
 *   turns' clean marks for a day.
 * - Past fresh, the setup and the skills are still used for up to a day
 *   (`WARM_STALE_MS`), and read again beside the turn instead of before it:
 *   what that read finds goes in the copy this turn hands back, so the next
 *   text has it (Dev, 2026-11-04: a cold text spent 400 ms on the setup and
 *   750 ms on the skills before its model). A setup that read nothing is not
 *   carried on, so a removed one is gone by the text after.
 *   `docs/decisions/texting-assistant/warm-copy.md`.
 * - Never the history, About me or the jobs list (the owner, 2026-11-01: "ONE
 *   copy only", no second copy anywhere). They are read with one call to the
 *   person's own Tex Durable Object (`history.js`, `texDesk.js`), so no copy
 *   here can be behind them. `test/texHistoryOneCopy.test.mjs` fails if one
 *   comes back.
 * - Never the chat's day either (Dev2, 2026-11-05): every turn reads it from
 *   the chat's ledger, with the Worker's outbox (`recent`) on top. A carried
 *   day was sealed before its turn's reply went, and the Worker forgets a
 *   reply once the gateway has it, so Tex never saw what it had said.
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
/** The chat's turns' clean marks, carried forward turn by turn (never the chat itself). */
export const WARM_CHAT_MS = 24 * 60 * 60 * 1000;
/**
 * The setup and the learned skills, past fresh: used this much longer while they are read again beside the turn
 * (`warmTurn` `part`), so a text after a quiet hour waits for neither. Who they are is never served stale.
 */
export const WARM_STALE_MS = 24 * 60 * 60 * 1000;
/** The parts served stale while read again. */
const SERVED_STALE = new Set(["setup", "skills"]);
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
    const setup = fresh(copy.setup, WARM_SETUP_MS), skills = fresh(copy.skills, WARM_NOTES_MS);
    // Past fresh and inside a day: used while read again (`WARM_STALE_MS`), never as fresh.
    const stale = { setup: setup === undefined ? fresh(copy.setup, WARM_STALE_MS) : undefined, skills: skills === undefined ? fresh(copy.skills, WARM_STALE_MS) : undefined };
    return { setup, skills, identity: fresh(copy.identity, WARM_NOTES_MS), stale, chat: chat && { at: chat.at, ...(chat.clean && typeof chat.clean === "object" ? { clean: chat.clean } : {}) } };
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
 * copy, but the Worker's outbox (`recent`, the events it has not posted yet)
 * goes on the chat's day from the ledger as a one-to-one chat's does (Dev,
 * 2026-11-02: the Worker keeps its outbox only, `apps/agent/src/chatRead.ts`).
 */
export function warmTurn(env, session, body, { eligible, logEligible = false, now = Date.now() }) {
  const opened = eligible ? openWarm(env, session, body?.warm, now) : Promise.resolve(null);
  const next = { v: 1 };
  const cleanSeen = {};
  // A background job writes on its own (task notes, the jobs list, a skill): while one runs, or just after, those are read fresh.
  const jobBusy = (Array.isArray(body?.running) ? body.running : []).some((job) => job?.state === "running" || (Number.isFinite(job?.finishedAt) && now - job.finishedAt < WARM_NOTES_MS));
  // A setup that could not be read is never kept: a turn without it runs on the built-in words, and a kept miss
  // held every turn after on them for an hour (`docs/decisions/texting-assistant/setup-read.md`).
  const keeps = (name, value) => name !== "setup" || typeof value === "string";
  // A part served stale whose read again found nothing to keep: not carried on by `seal`.
  const dropped = new Set();
  const part = (name) => async (read) => {
    const was = jobBusy && name === "skills" ? undefined : await opened;
    const warm = was?.[name];
    if (warm !== undefined && warm.value !== undefined && keeps(name, warm.value)) return (next[name] = warm).value;
    // Past fresh, inside a day: this turn uses it, and the read runs beside the turn for the copy it hands back.
    const stale = SERVED_STALE.has(name) ? was?.stale?.[name] : undefined;
    if (stale !== undefined && stale.value !== undefined && keeps(name, stale.value)) {
      next[name] = stale;
      Promise.resolve()
        .then(read)
        .then(
          (value) => {
            if (keeps(name, value)) next[name] = { at: now, value };
            else (delete next[name], dropped.add(name));
          },
          () => {
            // Unread: the stale copy is carried as it was, still bounded by its own time.
          },
        );
      return stale.value;
    }
    const value = await read();
    if (eligible && keeps(name, value)) next[name] = { at: now, value };
    return value;
  };
  const chat = (async () => (eligible ? (await opened)?.chat : undefined))();
  let chatRead = null;
  return {
    /** The setup's text; the turn parses it either way. */
    setup: part("setup"),
    /** The learned skills' index (`learnedSkills.js`). */
    skills: part("skills"),
    /** Who they are by their account (`identity.js`): the control plane's answer, never a note. */
    identity: part("identity"),
    /** The chat's day (the ledger's, `loggedTurn.js`), with the Worker's outbox on top. */
    async events(chatKey, read) {
      const logs = eligible || logEligible; // the texting Worker's own turn, one to one or a group's
      // Always the ledger's day, never a carried one (Dev2, 2026-11-05): a copy is sealed before the turn's reply goes and
      // the Worker forgets that reply once the gateway takes it, so a carried day never held Tex's own answers.
      const base = await read();
      const events = mergeEvents(base, logs ? body?.recent : null, { chat: chatKey, now }); // only the texting Worker's own turn hands events in
      chatRead = { events };
      return events;
    },
    /** Events this turn wrote again (a voice message once heard, `heardWords.js`): the day handed to the next turn carries them so. */
    restate(events) {
      const byId = new Map((Array.isArray(events) ? events : []).map((event) => [event.id, event]));
      if (chatRead?.events) chatRead = { events: chatRead.events.map((event) => byId.get(event.id) ?? event) };
    },
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
      for (const name of ["setup", "skills", "identity"]) if (out[name] === undefined && !dropped.has(name) && was?.[name] !== undefined && keeps(name, was[name]?.value) && !(name !== "setup" && jobBusy)) out[name] = was[name];
      if (wrote) delete out.skills;
      // A record only moves toward not clean (`loggedTurn.js` `recordTurn`): a retried turn id's earlier attempt may have recorded false, so its own clean exit is left for the next turn to read.
      const known = { ...(warm?.clean ?? {}), ...cleanSeen, ...(typeof turn === "string" && clean === false ? { [turn]: false } : {}) };
      if (typeof turn === "string" && clean !== false && known[turn] === true) delete known[turn];
      // The chat itself is never carried: the next turn reads its day from the ledger. Only the clean marks of the turns this
      // one was shown go on (all of them when it read no day: a yes the gateway settled).
      const events = chatRead?.events;
      const shown = new Set((events ?? []).map((event) => event.turn).filter(Boolean));
      if (typeof turn === "string") shown.add(turn);
      out.chat = {
        at: warm?.at ?? now,
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
