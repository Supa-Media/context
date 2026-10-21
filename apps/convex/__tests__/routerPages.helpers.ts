/// <reference types="vite/client" />
/**
 * The router's own list of first path segments that are not homepage pages,
 * borrowed for the control plane's tests.
 *
 * `NOT_PAGES` lives in `infra/router/src/homeSite.ts` and names every first
 * segment the apex serves itself — `/api`, `/og`, `/ingest`, the app's
 * routes — rather than drawing a homepage page at. It is the router's half of
 * the pair `gatewayRoutes.helpers.ts` documents for the gateway: a segment
 * the apex serves is a segment nobody should be able to claim as a name,
 * because ingestion is on the apex and a claimable name is a mailbox at
 * `<name>@context.lc`.
 *
 * Read rather than imported, for the reason that file gives: the check is
 * about the declaration as written. Parsed here rather than in
 * `@context/shared` because this is its only reader; the day a second one
 * appears, move the parse the way `parseGatewayRouteSegments` was moved.
 *
 * Returns an empty set when it cannot read the list, and the caller asserts a
 * floor on the size — a helper that silently returned nothing would make the
 * test pass by checking nothing.
 */

const ROUTER_SOURCES = import.meta.glob("../../../infra/router/src/homeSite.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every first path segment the router keeps off the homepage. */
export function routerNotPages(): ReadonlySet<string> {
  const source = Object.values(ROUTER_SOURCES)[0];
  if (typeof source !== "string") return new Set();
  const declaration = /const NOT_PAGES\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (declaration === null) return new Set();
  return new Set([...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}
