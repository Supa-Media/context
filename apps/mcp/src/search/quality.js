/**
 * What a search and an open tell the control plane for the admin console's search quality
 * (`apps/convex/functions/searchTimings.ts`): which surface searched, the searcher's opaque actor, the hits
 * the answer showed, and which hit the searcher opened.
 *
 * **Only hashes cross.** Every identifier that leaves the gateway here is the first 16 lowercase hex of
 * SHA-256 over a labelled seed: `search-actor:<grantId or userId>` for the searcher, and
 * `search-hit:<workspaceId>:<path>` for a hit in the workspace its note lives in. So a query, a note path,
 * a title or a snippet never reaches the control plane, and neither does a grant or user id on its own.
 *
 * **One counted row per search.** The timing row a workspace's search writes is timing only. The counted
 * row (`who`, `actor`, `hits`, or `surface: "app"`) is written once, after the answer is fused, on the
 * workspace the search was asked in, with the fused hits in order and each hashed with its own workspace.
 */

import { normalizePath } from "../notes/paths.js";

/**
 * The clients that run a Tex turn. Tex's turns come in on `/agent` (`http/route.js`), and the grant that
 * session resolved names which client it is; a search inside one of those turns is Tex's, any other client's
 * is an AI client's. Routines, housekeeping, dreams and the heartbeat are Tex's own turns too.
 */
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

/** First 16 lowercase hex of SHA-256 over `text`. */
export async function searchHash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let hex = "";
  for (const byte of new Uint8Array(digest).subarray(0, 8)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** The searcher's actor: the same in every workspace the searcher reaches, so a search and its opens match across them. */
export const searchActorHash = (seed) => searchHash(`search-actor:${seed}`);

/** One note's hit in one workspace, as a search row names it and an open names it. */
export const searchHitHash = (workspaceId, path) => searchHash(`search-hit:${workspaceId}:${path}`);

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
 * The counted row for one search, after its answer is fused. `hits` are `{workspaceId, path}` in result
 * order. Never throws: a row that cannot be written is a row not counted, never a failed search.
 *
 * Nothing is written when no workspace's own search answered (`lastSearch` unset): the counted row names the
 * asked-in workspace's search, and there is none to name.
 *
 * @param {object} store the store the search was asked in
 * @param {{workspaceId: string, path: string}[]} hits
 */
export function reportCountedSearch(store, hits) {
  try {
    const last = store.lastSearch;
    if (!last || typeof store.reportSearchTiming !== "function") return;
    const list = Array.isArray(hits) ? hits : [];
    const row = { answeredBy: last.answeredBy, found: list.length > 0, ms: last.ms };
    if (store.searchSurface === "app") {
      // The app's own bar: a surface of its own, and no searcher id or hits (`http/appSearch.js`).
      store.reportSearchTiming({ ...row, surface: "app" });
    } else {
      store.reportSearchTiming({
        ...row,
        who: searchWhoOf(store.actor),
        seed: actorSeedOf(store.actor),
        hits: list.slice(0, MAX_QUALITY_HITS),
      });
    }
  } catch {
    // Instrumentation must never be how a search fails.
  }
}

/**
 * The body a timing row is sent with, every hash taken here. A row with no counted fields is the timing row
 * it always was: `workspaceId`, `answeredBy`, `found`, `ms`. `timing.hits` are `{workspaceId, path}`.
 */
export async function searchTimingFields(workspaceId, timing) {
  const fields = { workspaceId, answeredBy: timing.answeredBy, found: timing.found, ms: timing.ms };
  if (timing.surface === "app") return { ...fields, surface: "app" };
  if (timing.who === undefined) return fields;
  fields.who = timing.who;
  if (timing.seed) fields.actor = await searchActorHash(timing.seed);
  if (Array.isArray(timing.hits)) {
    fields.hits = await Promise.all(timing.hits.slice(0, MAX_QUALITY_HITS).map((hit) => searchHitHash(hit.workspaceId, hit.path)));
  }
  return fields;
}

/**
 * Report that a note's content went back to the caller, as the open of the search hit that named it.
 * Called after a successful read (`tools/dispatch.js` `callTool`). Only `read_note` and the ChatGPT `fetch`
 * open a note; anything else, a refusal and a mail or history read included, is not an open.
 */
export function reportOpenedNote(name, args, store, result) {
  try {
    if (result?.isError || typeof store?.reportSearchOpen !== "function") return;
    const raw = name === "read_note" && args?.mail === undefined ? args?.path : name === "fetch" ? args?.id : undefined;
    if (typeof raw !== "string") return;
    const path = normalizePath(raw);
    if (path) store.reportSearchOpen(path);
  } catch {
    // An open that cannot be reported is no reason to fail the read.
  }
}
