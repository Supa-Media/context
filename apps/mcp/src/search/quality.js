/**
 * What a search and an open tell the control plane for the admin console's search quality
 * (`apps/convex/functions/searchTimings.ts`): which surface searched, the searcher's actor, the hits
 * the answer showed, and which hit the searcher opened.
 *
 * **Only keyed MACs cross, and Convex never holds the key.** Every identifier that leaves the gateway here is
 * the first 16 lowercase hex of HMAC-SHA-256 under a key derived with HKDF (info `context-search-quality-v1`)
 * from a root secret this gateway holds and the control plane does not. The inputs are `search-actor:<grant id,
 * or user id>` for the searcher and `search-hit:<address>` for a hit, where the address is the one the caller
 * reads the note by: the plain path in the workspace it asked in, `@<name>/<path>` for another workspace's note.
 * An unkeyed hash of an id or a path is reversible by anyone who can read the log, so none is ever sent. With no
 * root, nothing is sent but the timing: no actor, no hits, and no `who`.
 *
 * **One counted row per search.** The timing row a workspace's search writes is timing only. The counted
 * row (`who`, `actor`, `hits`, or `surface: "app"`) is written once, after the answer is fused, on the
 * workspace the search was asked in, with the fused hits in order.
 */

/** The clients that run a Tex turn. A search inside one of those turns is Tex's; any other client's is an AI client's. */
const TEX_CLIENTS = new Set([
  "context_texts",
  "context_texts_group",
  "context_routines",
  "context_housekeeping",
  "context_dreams",
  "context_heartbeat",
]);

/** A hit list is capped at this many entries on the wire. */
export const MAX_QUALITY_HITS = 10;

import { normalizePath } from "../notes/paths.js";

const HKDF_INFO = "context-search-quality-v1";
const encoder = new TextEncoder();

/**
 * HKDF-SHA-256 (RFC 5869) to one 32-byte block, spelled with HMAC the way `store/managedEncryption.js` spells
 * its own: the gateway's crypto stays HMAC and digest calls. The empty salt is HashLen zeros, which HMAC pads to
 * the same key, so this is the WebCrypto HKDF with no salt, byte for byte (`__tests__` checks it against one).
 *
 * @param {string | null | undefined} root
 * @returns {Promise<CryptoKey | null>}
 */
export async function deriveSearchQualityKey(root) {
  if (typeof root !== "string" || root.length < 16) return null;
  const extract = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prkBytes = new Uint8Array(await crypto.subtle.sign("HMAC", extract, encoder.encode(root)));
  const expand = await crypto.subtle.importKey("raw", prkBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const info = encoder.encode(HKDF_INFO);
  const block = new Uint8Array(info.length + 1);
  block.set(info);
  block[info.length] = 1;
  const okm = new Uint8Array(await crypto.subtle.sign("HMAC", expand, block));
  return crypto.subtle.importKey("raw", okm, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/**
 * The root the search quality key is derived from, read from the Worker's env. None is named yet, so this is
 * always null and the log carries timing only. `GATEWAY_SECRET` is not a candidate: the control plane holds it
 * (it is the bearer it checks on every gateway call), so a key derived from it is a key Convex can compute.
 * Name a binding here that only this Worker holds, then nothing else in this file changes.
 *
 * @param {object | undefined} env
 * @returns {string | null}
 */
export function searchQualityRoot(env) {
  void env;
  return null;
}

const keyCache = new WeakMap();

/**
 * The quality key for a Worker env, derived once per env object. Resolves to null when there is no root.
 *
 * @param {object | undefined} env
 * @returns {Promise<CryptoKey | null>}
 */
export function searchQualityKeyOf(env) {
  if (env === null || typeof env !== "object") return deriveSearchQualityKey(null);
  if (!keyCache.has(env)) keyCache.set(env, deriveSearchQualityKey(searchQualityRoot(env)));
  return keyCache.get(env);
}

/** 16 lowercase hex: the first 8 bytes of HMAC-SHA-256 under `key` over `text`. */
export async function searchMac(key, text) {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
  let hex = "";
  for (const byte of mac.subarray(0, 8)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** The searcher's actor: the same in every workspace the searcher reaches, so a search and its opens match across them. */
export const searchActorHash = (key, seed) => searchMac(key, `search-actor:${seed}`);

/** One note's hit, by the address the caller reads it by (the plain path, or `@name/path` from another workspace). */
export const searchHitHash = (key, address) => searchMac(key, `search-hit:${address}`);

/** The id a session's searches and opens are linked by: its grant, or its user when it has none. */
export function actorSeedOf(actor) {
  if (typeof actor?.grantId === "string" && actor.grantId !== "") return actor.grantId;
  if (typeof actor?.userId === "string" && actor.userId !== "") return actor.userId;
  return null;
}

/** Who a gateway search is: Tex's own turn, or an AI client. */
export function searchWhoOf(actor) {
  return TEX_CLIENTS.has(actor?.clientId) ? "tex" : "ai";
}

/**
 * Remember how the search this request ran was answered, for the counted row that follows the fused answer
 * (`reportCountedSearch`). Called by `search/visibleNotes.js` on the store a search was asked in. While an
 * entry point is collecting its row (`store.searchRowPending`), the workspace's own timing row is held back
 * here, so a search writes one timing row, not two.
 */
export function holdSearchTiming(store, answeredBy, ms) {
  store.lastSearch = { answeredBy, ms };
}

/**
 * The counted row for one search, after its answer is fused. `addresses` are the hits' keys in result order:
 * the plain path, or `@name/path`. Never throws: a row that cannot be written is a row not counted, never a
 * failed search.
 *
 * Nothing is written when no workspace's own search answered (`lastSearch` unset).
 *
 * @param {object} store the store the search was asked in
 * @param {string[]} addresses
 */
export function reportCountedSearch(store, addresses) {
  try {
    const last = store.lastSearch;
    if (!last || typeof store.reportSearchTiming !== "function") return;
    const list = Array.isArray(addresses) ? addresses : [];
    const row = { answeredBy: last.answeredBy, found: list.length > 0, ms: last.ms };
    if (store.searchSurface === "app") {
      // The app's own bar: a surface of its own, and no searcher id or hits (`http/appSearch.js`).
      store.reportSearchTiming({ ...row, surface: "app" });
    } else {
      store.reportSearchTiming({
        ...row,
        who: searchWhoOf(store.actor),
        seed: actorSeedOf(store.actor),
        hits: list.filter((address) => typeof address === "string").slice(0, MAX_QUALITY_HITS),
      });
    }
  } catch {
    // Instrumentation must never be how a search fails.
  }
}

/**
 * The body a timing row is sent with, every MAC taken here with `key`. A row with no counted fields is the
 * timing row it always was: `workspaceId`, `answeredBy`, `found`, `ms`. With no key (no root), the counted
 * fields are left out entirely: a timing row, never an unkeyed hash.
 *
 * @param {string} workspaceId
 * @param {object} timing
 * @param {CryptoKey | null} key
 */
export async function searchTimingFields(workspaceId, timing, key) {
  const fields = { workspaceId, answeredBy: timing.answeredBy, found: timing.found, ms: timing.ms };
  if (timing.surface === "app") return { ...fields, surface: "app" };
  if (timing.who === undefined || key === null) return fields;
  const actor = timing.seed ? await searchActorHash(key, timing.seed) : undefined;
  if (actor === undefined) return fields;
  fields.who = timing.who;
  fields.actor = actor;
  if (Array.isArray(timing.hits)) {
    fields.hits = await Promise.all(timing.hits.slice(0, MAX_QUALITY_HITS).map((address) => searchHitHash(key, address)));
  }
  return fields;
}

/**
 * The address a note is read by, as a search names its hit: the plain path in the workspace the caller is
 * working in (its own, or none given), `@name/path` for another one. Matches `searchHits`' keys.
 *
 * @param {object} store the request's store (`contexts` names the caller's own context with `current`)
 * @param {string} path a normalized note path
 * @param {unknown} context the `context` argument the read named, if any
 */
export function searchAddressOf(store, path, context) {
  if (typeof context !== "string" || context.trim() === "") return path;
  const named = context.startsWith("@") ? context : `@${context}`;
  if (store?.contexts?.some((entry) => entry.current === true && entry.name === named)) return path;
  return `${named}/${path}`;
}

/**
 * Report that a note's content went back to the caller, as the open of the search hit that named it.
 * Called after a successful read (`tools/dispatch.js` `callTool`). Only `read_note` and the ChatGPT `fetch`
 * open a note; anything else, a refusal and a mail or history read included, is not an open. A `read_note`
 * with `context: "@x"` opens `@x/<path>`, which is the address its search hit carries.
 */
export function reportOpenedNote(name, args, store, result) {
  try {
    if (result?.isError || typeof store?.reportSearchOpen !== "function") return;
    const raw = name === "read_note" && args?.mail === undefined ? args?.path : name === "fetch" ? args?.id : undefined;
    if (typeof raw !== "string") return;
    const path = normalizePath(raw);
    if (!path) return;
    store.reportSearchOpen(searchAddressOf(store, path, name === "read_note" ? args?.context : undefined));
  } catch {
    // An open that cannot be reported is no reason to fail the read.
  }
}
