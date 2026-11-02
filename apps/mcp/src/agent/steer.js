/**
 * A text sent while Tex is still working joins the job already running.
 *
 * Every text waited for the answer before it, so "oh and make it Friday",
 * sent while Tex was booking, was answered on its own after the booking was
 * done the old way (Dev, 2026-10-19, choosing Hermes's "steer" mode over its
 * default of stopping and starting again). The texting Worker names each
 * texted turn (`turn`), and a text that arrives during one is sent here
 * (`POST /agent/steer`) as well as kept in its queue. The running turn picks
 * it up after its next tool call and is shown it as the person's own words;
 * its answer names the texts it took (`steered`), and the Worker drops those
 * from its queue. A text that lands after the turn's last look is answered
 * on its own, as before.
 *
 * Any kind of message the Worker forwards is steered (Dev2, 2026-10-26,
 * reversing "replies, tapbacks and photos are never steered"): a text, an
 * inline reply's words, a tapback's words, a picture's caption. Each is words
 * only, capped the same (`MAX_STEER_TEXT`, `MAX_STEERED`), and vouches for
 * nothing, as below.
 *
 * A turn the Worker cancels (`POST /agent/cancel`, `textingRoutes.js`) is
 * marked under `.context/agent/cancel/<turn>.json`; the running turn asks
 * `cancelled()` after each round, where it takes steered texts, and stops.
 *
 * A background job's turn (`background.js`) is named the same way, by the
 * job's own object, in a 1:1 chat or a group: a follow-up the chat's turn
 * passed to the job arrives here with the job's grant. A group's ordinary
 * turns are never named, so two people's texts still never fold together.
 *
 * The words are the person's, but they arrived after the turn's guards were
 * set up from its first text (the browser's addresses, the sharing judge, the
 * Mail checker), so they vouch for nothing those guards allow. Kept in the
 * person's own bucket, under `.context/agent/steer/<turn>/`, only until the
 * turn ends, which clears its own folder and nobody else's.
 */

import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { toolIsWriting } from "../tools/registry.js";
import { sleepLineNote } from "./timeLog.js";

const TEXTS_CLIENT_ID = "context_texts";
/** A group chat's grant (`apps/convex/functions/textGroups.ts`): only its background jobs name a turn. */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
const texting = (session) => session.actorClientId === TEXTS_CLIENT_ID || session.actorClientId === TEXTS_GROUP_CLIENT_ID;
export const STEER_PREFIX = ".context/agent/steer/";
const TURN = /^[A-Za-z0-9_-]{8,64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MAX_STEER_TEXT = 4_000;
export const CANCEL_PREFIX = ".context/agent/cancel/";
/** A named turn while it runs: `{ user, wrote }` (`wrote`: a writing call may have started; written before it runs). */
export const RUNNING_PREFIX = ".context/agent/running/";
/** Calls outside the MCP's own tools that only read; any other one that succeeds may have changed something. */
const READS = new Set(["search_web", "open_page", "read_skill", "read_learned_skill", "travel_time"]);
const writing = (name) => !READS.has(name) && toolIsWriting(name);
/** Refused when the running record cannot say a write may start: a cancel could otherwise succeed after it. */
const UNRECORDED = { isError: true, content: [{ type: "text", text: "Could not record that this turn is about to change something, so it did not run. Try again." }] };
/** The most texts one turn takes in. */
export const MAX_STEERED = 5;

/** A key segment from a Worker's event id: the characters a key may hold. */
function keyOf(id) {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `POST /agent/steer` `{ turn, id, text }`: keep a text for the turn it arrived during. */
export async function handleSteer(request, store, session) {
  if (!texting(session) || !hasScope(session, SCOPE_WRITE)) return json({ error: "forbidden" }, 403);
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const { turn, id, text } = body ?? {};
  if (typeof turn !== "string" || !TURN.test(turn) || typeof id !== "string" || !ID.test(id) || typeof text !== "string") {
    return json({ error: "invalid_request" }, 400);
  }
  const words = text.trim().slice(0, MAX_STEER_TEXT);
  if (words === "") return json({ error: "invalid_request" }, 400);
  await store.put(`${STEER_PREFIX}${turn}/${Date.now()}-${keyOf(id)}.json`, JSON.stringify({ id, text: words }));
  return json({ queued: true });
}

/**
 * The running turn's side: `take()` returns the texts not yet taken, oldest
 * first, and `taken` the Worker's ids for them. Null for anything but a texted
 * turn the Worker named.
 */
export function steerFor(store, session, body) {
  if (!texting(session) || typeof body?.turn !== "string" || !TURN.test(body.turn)) return null;
  const prefix = `${STEER_PREFIX}${body.turn}/`;
  const running = `${RUNNING_PREFIX}${body.turn}.json`;
  let open = 0; // writing calls started and not shown held
  let marked = null; // the running record's `wrote: true`, once written
  const mark = (value) => store.put(running, JSON.stringify({ user: session.actorUserId, wrote: value }));
  const seen = new Set();
  const taken = [];
  const words = [];
  return {
    taken,
    words,
    /** Whether a text that came in while the reply was written joins it (`turn.js`). Not a job's: its next part takes it (`apps/agent/src/jobRun.ts`). */
    late: !body.job,
    /** Whether a writing call may have started: from then on no cancel stops the turn. */
    get wrote() {
      return open > 0;
    },
    /** The line the turn is given after a tool round, or null when nothing came. */
    async next() {
      const texts = await this.take();
      return texts.length > 0 ? steeredLine(texts, { notes: true }) : null;
    },
    async take() {
      if (taken.length >= MAX_STEERED) return [];
      try {
        const page = await store.list({ prefix, limit: 20 });
        const keys = (page?.objects ?? []).map((object) => object.key).filter((key) => !seen.has(key)).sort();
        const texts = [];
        for (const key of keys.slice(0, MAX_STEERED - taken.length)) {
          seen.add(key);
          const object = await store.get(key);
          const entry = object ? JSON.parse(await object.text()) : null;
          if (typeof entry?.id !== "string" || typeof entry?.text !== "string") continue;
          taken.push(entry.id);
          words.push(entry.text);
          texts.push(entry.text);
        }
        return texts;
      } catch {
        return []; // a text not picked up is answered on its own
      }
    },
    /**
     * Whether a text sent to this turn is still waiting, untaken. For a job,
     * that means its answer will not be texted: the Worker runs another part
     * with that text instead (`apps/agent/src/jobRun.ts`).
     */
    async pending() {
      try {
        const page = await store.list({ prefix, limit: 20 });
        return (page?.objects ?? []).some((object) => !seen.has(object.key));
      } catch {
        return false;
      }
    },
    /** Mark the turn running, so `/agent/cancel` may stop it. */
    async begin() {
      await store.put(running, JSON.stringify({ user: session.actorUserId, wrote: false })).catch(() => {});
    },
    /**
     * A tool call (or a web one, `web`). A writing one marks the turn as having
     * changed something before it runs (pessimistic), and does not run when
     * that mark cannot be written: no cancel after it. Only a call held for a
     * yes, which ran nothing, takes the mark back.
     */
    track(call) {
      return async (name, args) => {
        if (!writing(name)) return call(name, args);
        open += 1;
        try {
          await (marked ??= mark(true));
        } catch {
          open -= 1;
          marked = null;
          return UNRECORDED;
        }
        const result = await call(name, args);
        if (result?.held === true && --open === 0) {
          marked = null;
          await mark(false).catch(() => {}); // left true, a cancel is only refused
        }
        return result;
      };
    },
    trackWeb(web) {
      return web === null ? null : { ...web, call: this.track((name, args) => web.call(name, args)) };
    },
    /**
     * At the turn's end, before it answers: no longer running, then whether a
     * cancel landed after its last look. In that order, against `/agent/cancel`
     * writing its mark before reading the running one: a cancel that saw the
     * turn running is always seen here.
     */
    async endCancelled() {
      await store.delete(running).catch(() => {});
      return open === 0 && this.cancelled();
    },
    /** Whether the Worker cancelled this turn. */
    async cancelled() {
      try {
        return (await store.get(`${CANCEL_PREFIX}${body.turn}.json`)) !== null;
      } catch {
        return false;
      }
    },
    /** Clear what this turn was sent, taken or not: one not taken is answered on its own; and its cancel mark. */
    async clear() {
      try {
        await store.delete(`${CANCEL_PREFIX}${body.turn}.json`);
        await store.delete(running);
        const page = await store.list({ prefix, limit: 100 });
        await Promise.all((page?.objects ?? []).map((object) => store.delete(object.key)));
      } catch {
        // Left over, it is the person's own words in their own bucket.
      }
    },
  };
}

/**
 * `/agent/cancel`'s side: marks a turn cancelled only while it runs, for this
 * person, and has not yet changed anything; else nothing, and false.
 */
export async function cancelTurn(store, session, turn) {
  const state = async () => {
    try {
      const object = await store.get(`${RUNNING_PREFIX}${turn}.json`);
      return object === null ? null : JSON.parse(await object.text());
    } catch {
      return null;
    }
  };
  const before = await state();
  if (before?.user !== session.actorUserId || before.wrote === true) return false;
  const mark = `${CANCEL_PREFIX}${turn}.json`;
  await store.put(mark, JSON.stringify({ at: Date.now() }));
  // Ended meanwhile: whether it saw the mark cannot be told, so this says no; the turn's own answer says `cancelled` if it did.
  const now = await state();
  if (now?.user === session.actorUserId && now.wrote !== true) return true;
  await store.delete(mark).catch(() => {});
  return false;
}

/** How a taken text reaches the model, with what the gateway read in it (`timeLog.js`), and the conversation, without. */
export function steeredLine(texts, { notes = false } = {}) {
  return texts.map((text) => [`(They texted this while you were working on it; take it into account:) ${text}`, notes ? sleepLineNote(text) : ""].filter(Boolean).join("\n")).join("\n\n");
}
