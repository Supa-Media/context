/// <reference types="vite/client" />
/**
 * The gateway's own list of path segments that name a route rather than a
 * context, borrowed for the control plane's tests.
 *
 * ## Why this is read rather than restated
 *
 * `RESERVED_FIRST_SEGMENTS` lives in `apps/mcp/src/session.js` and decides, on
 * every request, whether `/@foo/mcp` means "the context called foo" or "the
 * route called foo". `RESERVED_NAMES` in `functions/lib/names.ts` decides
 * whether anybody may be called `foo` in the first place. The two are a pair,
 * and nothing was holding them together: `names.test.ts` asserted five strings
 * somebody typed, and `granola-webhook` — a real gateway route since it was
 * written — was claimable as a username and as a workspace slug.
 *
 * The list is not cosmetic on either side. CLAUDE.md's "Ingestion is on the
 * apex, which makes the reserved-name list a security control" means a name
 * that can be claimed is a mailbox at `<name>@context.lc`; and a name the
 * gateway reads as a route is a context nobody can point a client at.
 *
 * So this reaches for the real thing, the way `gatewayFormat.helpers.ts`
 * reaches for the real privacy parser. Extracting rather than importing for
 * the same reason it gives: `session.js`'s declaration is module-private, and
 * exporting it would mean editing `apps/mcp` to satisfy a test.
 *
 * ## What it does when it cannot read the list
 *
 * It returns an empty set, and the caller asserts a floor on the size. A
 * helper that silently returned nothing would turn this into a test that
 * passes because it checked nothing — which is the failure the whole exercise
 * is about.
 */

/**
 * Globbed rather than imported as `"…/session.js?raw"`, matching
 * `gatewayFormat.helpers.ts`, so the typing dependency stays the one this
 * package already carries.
 */
const SESSION_SOURCES = import.meta.glob("../../mcp/src/session.js", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Every first path segment the gateway refuses to read as a context slug.
 *
 * Parsed out of the literal rather than evaluated: `session.js` is an ES module
 * with imports, and evaluating it to read one constant would couple this to
 * everything else in it. The shape it matches is the declaration as written —
 * a `new Set([...])` of string literals — and a rewrite into any other shape
 * yields an empty set, which the caller's floor turns into a failure rather
 * than a silent pass.
 */
export function gatewayReservedFirstSegments(): ReadonlySet<string> {
  const source = Object.values(SESSION_SOURCES)[0];
  if (typeof source !== "string") return new Set();

  const declaration = /const RESERVED_FIRST_SEGMENTS = new Set\(\[([\s\S]*?)\]\)/.exec(
    source,
  );
  if (declaration === null) return new Set();

  // Comments first. Every quoted string in the block was being read as an
  // entry, so an ordinary `// see "seyi" in the docs` inside the declaration
  // reported `seyi` as an unreserved gateway route — a wrong diagnosis from a
  // guard whose whole job is to fail informatively.
  const body = declaration[1]!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const segments = [...body.matchAll(/"([^"]*)"|'([^']*)'/g)].map(
    (match) => match[1] ?? match[2]!,
  );
  return new Set(segments);
}
