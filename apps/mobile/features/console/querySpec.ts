import type { RequestForQueries } from "convex/react";

/**
 * The one shared "subscribe to nothing" spec.
 *
 * ## Why this constant has to exist
 *
 * `useQueries` requires its argument to be **referentially stable across
 * renders**, and it fails violently when it is not. The chain, in Convex's own
 * source:
 *
 *  1. `useQueriesHelper` memoises the subscription object on `[observer, queries]`.
 *  2. `useSubscription` compares that object to the one in state and, when it
 *     differs, calls `setState` **during render**.
 *  3. A spec with a new identity every render therefore sets state on every
 *     render, which React stops after ~25 attempts with
 *     *"Minified React error #301 — too many re-renders"*, having rendered
 *     nothing. The user sees a blank white page and no error.
 *
 * `useQuery` is immune because it memoises on `getFunctionName(ref)` — a
 * **string** — and stringified args. Anything calling `useQueries` directly has
 * to arrange that stability itself.
 *
 * ## The landmine
 *
 * The generated `api` is `anyApi`, a `Proxy` whose `get` handler returns a
 * **new proxy on every access**. So `api.functions.x.y !== api.functions.x.y`,
 * and any `useMemo` that lists an `api.…` reference in its dependency array
 * recomputes on every single render. That is what turned a spec that looked
 * memoised into one that was not, and it is invisible at the call site.
 *
 * **The rule: a `useQueries` spec memo may depend only on primitives** — ids,
 * names, booleans — and must reach for `api.…` *inside* the memo body. When the
 * answer is "no queries", return this shared object rather than a fresh `{}`,
 * so the empty case is stable too.
 */
export const EMPTY_QUERY_SPEC: RequestForQueries = Object.freeze(
  {},
) as RequestForQueries;
