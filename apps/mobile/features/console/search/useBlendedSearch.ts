/**
 * The search page, wired to `files.searchContexts`.
 *
 * One request per page, whatever the scope — that is the property the fan-out
 * was put in the control plane to give this hook, and everything here is built
 * on it: a page is one action call, "load more" is one more, and retrying a
 * context that failed is the same call with that one id in `contexts`.
 *
 * Four properties this hook owns, each of which the palette's own hook
 * (`files/useContextSearch.ts`) argues for at length and which are just as true
 * a page later:
 *
 *  - **The query is debounced and a short one is never sent.** Every keystroke
 *    reaching this endpoint is a fan-out across several customers' buckets.
 *  - **A late answer for an earlier query is dropped.** Each request records
 *    what it was for, so a fast reply to "ike" cannot overwrite "ikenna".
 *  - **A request that never settles ends.** `ConvexReactClient.action()` has no
 *    client-side timeout, so a lost uplink would otherwise leave a spinner
 *    nobody can dismiss. The server bounds each *source* at seven seconds; this
 *    bounds the request.
 *  - **Pages accumulate, and the accumulation is reset by the question and not
 *    by the answer.** Changing the query or the scope empties the list; a new
 *    page appends. Resetting on the answer instead is how "load more" turns
 *    into "replace what you were reading".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { raceTimeout } from "../storage/timeout";
import {
  MIN_QUERY,
  pageState,
  scopeIds,
  type BlendedAnswer,
  type BlendedResult,
  type PageState,
  type SearchableContext,
} from "./results";

/**
 * How long to wait for one page before saying we stopped waiting.
 *
 * Above the server's own per-source deadline plus the round trips around it, so
 * a page that is merely slow because one context is slow arrives as a partial
 * answer with a retry on it — which is something a person can act on — rather
 * than as a blanket failure, which is not.
 */
export const PAGE_TIMEOUT_MS = 15_000;

/** Long enough that typing a phrase does not fan out on its prefixes. */
const DEBOUNCE_MS = 300;

export interface BlendedSearchView {
  state: PageState;
  results: BlendedResult[];
  answer: BlendedAnswer | null;
  eligible: SearchableContext[];
  /** Whether another page exists. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /** Ask one context again, on its own. */
  retry: (workspaceId: string) => void;
  retrying: string | null;
}

export function useBlendedSearch(options: {
  query: string;
  /** Context slugs from the URL. Empty means every eligible context. */
  slugs: readonly string[];
}): BlendedSearchView {
  const convex = useConvex();
  const { query, slugs } = options;

  /*
    `useQueries` rather than `useQuery`, for the reason `useLiveConsoleData`
    gives at length: a failed `useQuery` re-throws during render and would take
    the whole console down from inside a pane. A thrown eligible list is an
    empty one here, and the page then draws "nothing is searchable" — which is
    wrong but survivable, and is corrected the moment the query recovers.

    `api.…` is reached for inside the memo and never in a dependency array: it
    is a proxy that mints a fresh object on every access, and one in a dep array
    re-renders forever. See `../querySpec.ts`.
  */
  const spec = useMemo<RequestForQueries>(
    () => ({
      contexts: { query: api.functions.fastSearch.searchableContexts, args: {} },
    }),
    [],
  );
  const answers = useQueries(spec);
  const eligible = useMemo<SearchableContext[]>(() => {
    const value = answers.contexts;
    return Array.isArray(value) ? (value as SearchableContext[]) : [];
  }, [answers.contexts]);

  const [answer, setAnswer] = useState<BlendedAnswer | null>(null);
  const [results, setResults] = useState<BlendedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  /**
   * The question the newest request was for.
   *
   * A string rather than the query alone, because the scope is half the
   * question: switching a chip while a request is in flight must drop that
   * request's answer exactly as retyping does.
   */
  const asked = useRef("");

  /**
   * Which "load more" and which retry are the newest, so a superseded one can
   * put its own flag down.
   *
   * The staleness guard below is about **data**: an answer for a question
   * nobody is asking any more must not reach the list. The flag is a different
   * thing — it is what disables the button while a request is out — and
   * clearing it behind the same guard is how a page ends up with a "Loading…"
   * that never becomes "Load more" again: change the query while a page is in
   * flight and the settle returns early, `loadingMore` stays true forever, and
   * `loadMore` refuses every later press. Same shape, same permanence, for
   * `retrying` and the retry button. So the flag is cleared whenever this
   * request is still the newest of its kind, whatever question it was for, and
   * only the data is held to the question.
   */
  const newestPage = useRef(0);
  const newestRetry = useRef(0);
  const scope = useMemo(() => scopeIds(slugs, eligible), [slugs, eligible]);
  const question = useMemo(
    // The separator is an ESCAPE, never the character: a literal NUL makes
    // git treat the file as binary, so it has no diff and cannot be
    // reviewed. What is wanted is its property — it occurs in neither half,
    // so two different questions cannot join into the same string.
    () => `${query.trim()}\u0000${[...scope].sort().join(",")}`,
    [query, scope],
  );

  /** One page, raced against a deadline so a lost request cannot hang. */
  const ask = useCallback(
    // `Id<"workspaces">` rather than `string`, so what this forwards is the
    // type the control plane's own validator names. `scopeIds` reads the ids
    // off the eligible list the server sent, which is the only place a real
    // one comes from — so the cast sits at that boundary and nowhere else.
    async (args: { query: string; contexts?: Id<"workspaces">[]; cursor?: string }) =>
      await raceTimeout(
        // Called inside the race so a client that throws synchronously is a
        // rejected promise here rather than an exception out of the caller.
        (async () =>
          (await convex.action(
            api.functions.files.searchContexts,
            args,
          )) as BlendedAnswer)(),
        {
          ms: PAGE_TIMEOUT_MS,
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (handle) => clearTimeout(handle),
        },
      ),
    [convex],
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      asked.current = question;
      setResults([]);
      setLoading(false);
      setFailed(false);
      // The answer is kept rather than cleared, and only for `eligibleCount`:
      // it is what lets an emptied field still say "nothing is searchable"
      // instead of falling back to "type something" for somebody who cannot.
      return;
    }

    setLoading(true);
    setFailed(false);
    const timer = setTimeout(() => {
      asked.current = question;
      void (async () => {
        const settled = await ask({
          query: trimmed,
          ...(scope.length > 0 ? { contexts: scope as Id<"workspaces">[] } : {}),
        });
        if (asked.current !== question) return;
        setLoading(false);
        if (settled.kind === "value") {
          setAnswer(settled.value);
          setResults(settled.value.results);
          return;
        }
        // A timeout and a rejection land together on purpose: both mean this
        // page has no answer, and what a person does about either is the same
        // — try again. The rows already on screen belong to a different
        // question, so they go.
        setResults([]);
        setFailed(true);
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [ask, query, question, scope]);

  const loadMore = useCallback(() => {
    const cursor = answer?.cursor;
    if (typeof cursor !== "string" || loadingMore) return;
    const forQuestion = question;
    const token = newestPage.current + 1;
    newestPage.current = token;
    setLoadingMore(true);
    void (async () => {
      const settled = await ask({
        query: query.trim(),
        ...(scope.length > 0 ? { contexts: scope as Id<"workspaces">[] } : {}),
        cursor,
      });
      // The button goes back up unless a newer press already owns it.
      if (newestPage.current !== token) return;
      setLoadingMore(false);
      // The question may have changed while the page was in flight, and an
      // appended page from the previous query would be indistinguishable from
      // a result once it is in the list.
      if (asked.current !== forQuestion) return;
      if (settled.kind !== "value") return;
      setAnswer(settled.value);
      setResults((current) => [...current, ...settled.value.results]);
    })();
  }, [answer?.cursor, ask, loadingMore, query, question, scope]);

  /**
   * One context, again.
   *
   * Deliberately not a different endpoint: a retry is the same blended search
   * narrowed to the source that failed, so it goes through the same
   * authorization, the same scope resolution and the same filter. What comes
   * back replaces that context's rows and its source row, and leaves every
   * other context's results where they were — re-running the whole page would
   * throw away four contexts' answers to re-ask the fifth.
   */
  const retry = useCallback(
    (workspaceId: string) => {
      if (retrying !== null) return;
      const forQuestion = question;
      const token = newestRetry.current + 1;
      newestRetry.current = token;
      setRetrying(workspaceId);
      void (async () => {
        const settled = await ask({
          query: query.trim(),
          contexts: [workspaceId as Id<"workspaces">],
        });
        if (newestRetry.current !== token) return;
        setRetrying(null);
        if (asked.current !== forQuestion) return;
        if (settled.kind !== "value") return;
        const fresh = settled.value;
        setResults((current) => [
          ...current.filter((row) => row.workspaceId !== workspaceId),
          ...fresh.results,
        ]);
        setAnswer((current) =>
          current === null
            ? fresh
            : {
                ...current,
                sources: current.sources.map((source) =>
                  source.workspaceId === workspaceId
                    ? (fresh.sources[0] ?? source)
                    : source,
                ),
              },
        );
      })();
    },
    [ask, query, question, retrying],
  );

  const state = pageState({
    query,
    loading,
    failed,
    answer,
    selected: scope.length,
  });

  return useMemo(
    () => ({
      state,
      results,
      answer,
      eligible,
      hasMore: typeof answer?.cursor === "string",
      loadingMore,
      loadMore,
      retry,
      retrying,
    }),
    [state, results, answer, eligible, loadingMore, loadMore, retry, retrying],
  );
}
