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

const TEXTS_CLIENT_ID = "context_texts";
/** A group chat's grant (`apps/convex/functions/textGroups.ts`): only its background jobs name a turn. */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
const texting = (session) => session.actorClientId === TEXTS_CLIENT_ID || session.actorClientId === TEXTS_GROUP_CLIENT_ID;
export const STEER_PREFIX = ".context/agent/steer/";
const TURN = /^[A-Za-z0-9_-]{8,64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MAX_STEER_TEXT = 4_000;
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
  const seen = new Set();
  const taken = [];
  const words = [];
  return {
    taken,
    words,
    /** The line the turn is given after a tool round, or null when nothing came. */
    async next() {
      const texts = await this.take();
      return texts.length > 0 ? steeredLine(texts) : null;
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
    /** Clear what this turn was sent, taken or not: one not taken is answered on its own. */
    async clear() {
      try {
        const page = await store.list({ prefix, limit: 100 });
        await Promise.all((page?.objects ?? []).map((object) => store.delete(object.key)));
      } catch {
        // Left over, it is the person's own words in their own bucket.
      }
    },
  };
}

/** How a taken text reaches the model, and the conversation. */
export function steeredLine(texts) {
  return texts.map((text) => `(They texted this while you were working on it; take it into account:) ${text}`).join("\n\n");
}
