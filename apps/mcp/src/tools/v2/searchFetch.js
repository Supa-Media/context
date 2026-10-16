/**
 * `search` and `fetch`, translated. STUB: passes the call through unchanged
 * until the per-id routing lands.
 */

export function translateSearch(args) {
  return { name: "search", arguments: { query: args.query } };
}

export function translateFetch(args) {
  return { name: "fetch", arguments: { id: args.id } };
}
