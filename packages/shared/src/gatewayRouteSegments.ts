/**
 * ONE READER FOR THE GATEWAY'S ROUTE SEGMENTS, BECAUSE THREE FILES HOLD THE LIST.
 *
 * `RESERVED_FIRST_SEGMENTS` decides whether `/@foo/mcp` means *the context
 * called foo* or *the route called foo*. It is written down three times, and
 * the three cannot import each other:
 *
 *  1. `apps/mcp/src/session.js` — the normative one. It is what actually
 *     answers the request, and its own comment says it does not get to assume
 *     the other copies stayed in sync.
 *  2. `apps/convex/functions/lib/names.ts` — `RESERVED_NAMES`, which decides
 *     whether anybody may be *called* one of them. Ingestion is on the apex, so
 *     that list is a mail-interception control: a claimable route segment is
 *     also somebody's mailbox.
 *  3. `apps/mobile/features/console/endpoints.ts` — the console's own copy,
 *     which decides whether the product prints `…/@foo/mcp` as the URL that
 *     reaches a context.
 *
 * **The third one had nothing holding it.** The control plane's side is held:
 * `names.test.ts` reads the gateway's set out of its source and fails if a
 * route it reserves is still claimable. The console's side was five strings
 * somebody typed — which is the same test the control plane's side used to
 * have, and the one that let a real route stay claimable for as long as it did.
 *
 * ## Why the source is parsed rather than imported
 *
 * `session.js`'s declaration is module-private, and exporting it would mean
 * editing the gateway to satisfy a test. `apps/convex` reaches the file through
 * a Vite `?raw` glob and `apps/mobile` through `node:fs`, so the two supply the
 * text differently — but they must not read it differently. **Two parsers for
 * one declaration is the drift this exists to catch**, which is why the parsing
 * lives here rather than beside either caller. `packages/shared/**` is in both
 * the `mobile` and `convex` change filters.
 *
 * ## What it does when it cannot read the list
 *
 * It returns an empty set, and every caller asserts {@link GATEWAY_ROUTE_FLOOR}
 * on the size. A helper that silently returned nothing would turn a guard into
 * a test that passes because it checked nothing.
 *
 * Nothing here is imported by shipped code — this module is reached by deep
 * import from tests only, exactly as the encryption-marker corpus beside it is.
 */

/**
 * The fewest segments a successful parse can yield.
 *
 * Seven are declared today. The floor is what turns "the declaration was
 * rewritten into a shape this does not match" into a failure rather than a
 * silent pass, so it is deliberately close to the real count: a floor of 1
 * would be satisfied by a regex that happened to catch one string in a comment.
 */
export const GATEWAY_ROUTE_FLOOR = 6;

/**
 * The name of the declaration, identical in the gateway and in the console —
 * which is what lets one parser read both.
 */
const DECLARATION = /const RESERVED_FIRST_SEGMENTS = new Set\(\[([\s\S]*?)\]\)/;

/**
 * Every first path segment a `RESERVED_FIRST_SEGMENTS` declaration names.
 *
 * Parsed out of the literal rather than evaluated: `session.js` is an ES module
 * with imports, and evaluating it to read one constant would couple this to
 * everything else in it.
 *
 * Comments are stripped first. Every quoted string in the block was otherwise
 * read as an entry, so an ordinary `// see "seyi" in the docs` inside the
 * declaration reported `seyi` as an unreserved gateway route — a wrong
 * diagnosis from a guard whose whole job is to fail informatively.
 */
export function parseGatewayRouteSegments(source: string): ReadonlySet<string> {
  if (typeof source !== "string") return new Set();

  const declaration = DECLARATION.exec(source);
  if (declaration === null) return new Set();

  const body = declaration[1]!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const segments = [...body.matchAll(/"([^"]*)"|'([^']*)'/g)].map(
    (match) => match[1] ?? match[2]!,
  );
  return new Set(segments);
}

/**
 * The `SLUG_PATTERN` literal a file declares, as written.
 *
 * A caller needs this to ask *which* route segments a name-shaped copy of the
 * list would even have to carry — and the honest way to ask is with the
 * pattern the file itself uses, not a fifth restatement of `[a-z0-9-]{2,32}`
 * in the helper that exists because restatements drift. Returned as the source
 * text so two files' declarations can be compared as text before either is
 * turned into a `RegExp`: identical text is the strongest form of agreement,
 * and the comparison says so without executing anything.
 */
export function parseSlugPatternSource(source: string): string | null {
  const declaration = /const SLUG_PATTERN = (\/[^\n]*\/[a-z]*);/.exec(source);
  return declaration === null ? null : declaration[1]!;
}
