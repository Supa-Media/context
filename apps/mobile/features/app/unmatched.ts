/**
 * The path segments a `+not-found` route was reached with.
 *
 * ## Why this is not `params["not-found"]` and left at that
 *
 * It is, first — that is the key Expo Router 6.0.24 uses, and it is derived
 * rather than guessed: `getReactNavigationConfig` turns the `+not-found`
 * segment into the pattern `*not-found`, and `replacePart` strips the `*` when
 * naming the param. `unmatched` was the name in earlier versions and is still
 * what most of the documentation says.
 *
 * So the key is an **implementation detail of a dependency**, in a screen whose
 * entire job is to be reached by URLs nobody anticipated. Getting it wrong does
 * not fail loudly: the screen still renders, and the only thing that quietly
 * stops working is recovering a note link that was sent to somebody. A pinned
 * upgrade would be the natural moment to break it and the least likely moment
 * to notice.
 *
 * Hence the fallback, which is a fact about the route rather than a guess about
 * the key: a `+not-found` route has exactly one dynamic parameter, it is a
 * catch-all, and `getParamValue` gives a catch-all its value as an **array**.
 * Query parameters — the other thing in this object — are strings. So the one
 * array-valued entry is the path, whatever it is called.
 *
 * `__tests__/notFoundRoute.test.ts` covers both the named key and the fallback,
 * so a rename in the dependency stays a passing test rather than a silent loss.
 */
export function unmatchedSegments(params: Record<string, unknown>): string[] {
  for (const key of ["not-found", "+not-found", "unmatched"]) {
    const named = params[key];
    if (Array.isArray(named)) return named.filter(isSegment);
    if (typeof named === "string" && named !== "") return [named];
  }

  for (const value of Object.values(params)) {
    if (Array.isArray(value) && value.every(isSegment)) return value;
  }
  return [];
}

function isSegment(value: unknown): value is string {
  return typeof value === "string";
}
