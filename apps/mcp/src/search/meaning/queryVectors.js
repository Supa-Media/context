/**
 * A query's fingerprint, kept for a few minutes for the person who asked it: the same words asked again (an assistant
 * that searches twice in one conversation, a search page opened again) are not sent to the model again, which is about
 * 150 to 200 ms of every search (production `mcp_entry`, 2026-11-18, `phase:meaning_embed`).
 *
 * The same text always gets the same fingerprint from the same model, so a kept one changes no answer.
 *
 * ## Whose it is
 *
 * Kept per person, never per workspace or for everyone. A fingerprint says nothing about anyone's notes, but how
 * long a search takes would: shared, a member could tell that somebody else had just searched the same words by
 * their own search coming back faster. So the key holds the asking person (or their connection, where a store names
 * no person), and a store that names neither keeps nothing.
 *
 * ## What is held
 *
 * In this isolate's memory only, never stored: at most `MOST` fingerprints, each for `KEEP_MS`. The key is a SHA-256
 * of the person and the words, so the words themselves are not held. Kept per model binding, so two hosts in one
 * process (tests) never read each other's.
 */

import { meaningEmbedderFor } from "./store.js";
import { phaseTook } from "../../mcp/phase.js";

/** How long a fingerprint is kept. */
export const KEEP_MS = 10 * 60 * 1000;
/** Most fingerprints kept per model binding (about 8 KB each). */
export const MOST = 200;

const KEPT = new WeakMap();

async function keyOf(owner, text) {
  const bytes = new TextEncoder().encode(`${owner}\u0000${text}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * The store's embedder (`meaningEmbedderFor`), answering one query's fingerprint from memory where this person asked
 * the same words within `KEEP_MS`. Anything else (several texts, a store with no model binding or no person) goes to
 * the model as before. A failed call keeps nothing.
 *
 * @param {object} store
 * @param {{fetchImpl?: Function, now?: () => number}} [options]
 */
export function queryEmbedderFor(store, { fetchImpl, now = Date.now } = {}) {
  const embed = meaningEmbedderFor(store, { fetchImpl });
  const ai = store?.ai;
  const owner = store?.actor?.userId ?? store?.actor?.grantId ?? null;
  if (!ai || typeof ai !== "object" || typeof owner !== "string" || owner === "") return embed;
  let kept = KEPT.get(ai);
  if (kept === undefined) KEPT.set(ai, (kept = new Map()));
  return async (texts) => {
    if (!Array.isArray(texts) || texts.length !== 1 || typeof texts[0] !== "string") return embed(texts);
    const key = await keyOf(owner, texts[0]);
    const held = kept.get(key);
    if (held !== undefined && now() - held.at < KEEP_MS) {
      // Counted beside the search's other steps as `inside:meaning_embed_kept`, a name and no words.
      phaseTook(store, "meaning_embed_kept", 0);
      return [held.vector];
    }
    const [vector] = await embed(texts);
    if (Array.isArray(vector) || vector instanceof Float32Array) {
      kept.delete(key);
      kept.set(key, { vector, at: now() });
      // The oldest kept goes first: a Map lists its keys in the order they were set.
      while (kept.size > MOST) kept.delete(kept.keys().next().value);
    }
    return [vector];
  };
}
