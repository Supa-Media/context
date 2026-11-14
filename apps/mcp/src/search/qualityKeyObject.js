/**
 * The root the search quality key is derived from (`search/quality.js`), kept in a Durable Object of its own so
 * that only this gateway ever holds it.
 *
 * Every identifier the search quality log carries is an HMAC under a key the control plane must not be able to
 * compute: a plain hash of a grant id or a path is reversible by anyone who can read the log. The gateway's only
 * secret, `GATEWAY_SECRET`, is the bearer the control plane checks on every call, so Convex holds it too and a key
 * derived from it is a key Convex can derive. This object makes 32 random bytes the first time it is asked and keeps
 * them; a Durable Object answers only to Workers in its own account, so the control plane never reaches it, and no
 * person adds a secret anywhere.
 *
 * One object, one key. Losing or deleting it rotates the key, which costs nothing: a search and its open are only
 * paired for 15 minutes, so the next pair is made under the new key.
 *
 * Self-hosting on the free tier: leave the `SEARCH_QUALITY_KEY` binding out, and the search log carries timing only.
 */

import { objectByName } from "../objectPlace.js";

/** The one object's name. */
export const SEARCH_QUALITY_KEY_OBJECT = "search-quality-key:v1";

/** The bytes of a new root. */
const ROOT_BYTES = 32;

function hex(bytes) {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

export class SearchQualityKeyObject {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    // No await between the read and the write but the storage calls themselves, which the object's input gate holds
    // every other request behind: two first asks cannot both make a root.
    let root = await this.state.storage.get("root");
    if (typeof root !== "string" || root.length !== ROOT_BYTES * 2) {
      root = hex(crypto.getRandomValues(new Uint8Array(ROOT_BYTES)));
      await this.state.storage.put("root", root);
    }
    return new Response(JSON.stringify({ root }), { status: 200, headers: { "content-type": "application/json" } });
  }
}

/**
 * The root from the object, or null with no binding or on any failure. Never throws.
 *
 * @param {object | undefined} env
 * @returns {Promise<string | null>}
 */
export async function fetchSearchQualityRoot(env) {
  const namespace = env?.SEARCH_QUALITY_KEY;
  if (!namespace || typeof namespace.idFromName !== "function") return null;
  try {
    const answer = await objectByName(namespace, SEARCH_QUALITY_KEY_OBJECT).fetch(
      new Request("https://search-quality-key.invalid/root", { method: "POST" }),
    );
    if (answer.status !== 200) return null;
    const body = await answer.json();
    return typeof body?.root === "string" && /^[0-9a-f]{64}$/.test(body.root) ? body.root : null;
  } catch {
    return null;
  }
}
