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
 *
 * And a fifth, from the palette too: **with no connection the page answers
 * from the copies on the device** (`deviceSearch.ts`, over
 * `features/offline/mirrorSearch.ts`). Offline, the control plane is not
 * asked; online, it is, and only a request that failed or timed out falls
 * back to the device — labelled as that in `notice`, never passed off as the
 * page's usual answer. The rule and its reasons are `useContextSearch`'s.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { raceTimeout } from "../storage/timeout";
import type { Reachability } from "../../offline/copy";
import type { DeviceSearchReason } from "../../offline/mirrorCopy";
import type { DeviceSearchAnswer } from "../../offline/mirrorSearch";
import type { MirrorStatus } from "../../offline/mirrorStatus";
import {
  blendDeviceAnswers,
  deviceSearchPageNotice,
  type DeviceSearchContext,
  type DeviceSourceAnswer,
} from "./deviceSearch";
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
  /**
   * Every context this page searches, and how each one is answered — the scope
   * picker's list and the upsell's, which are now the same list.
   */
  contexts: SearchableContext[];
  /** Whether another page exists. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /** Ask one context again, on its own. */
  retry: (workspaceId: string) => void;
  retrying: string | null;
  /**
   * A sentence for above the results when they came from the device, or
   * `null` when the control plane answered. See `deviceSearchPageNotice`.
   */
  notice: string | null;
}

/**
 * The copies on this device, as the page hands them in. The contexts come from
 * the console's own list (which survives a cold start offline, from memory —
 * `useRememberedContexts`) rather than from `searchableContexts`, which is a
 * Convex subscription and is exactly what is missing offline.
 */
export interface BlendedDeviceSearch {
  reachability: Reachability;
  contexts: readonly (DeviceSearchContext & { role: string })[];
  statuses: ReadonlyMap<string, MirrorStatus>;
  /** `null` — no mirror on this device at all. */
  search: (
    context: { workspaceId: string; role: string },
    query: string,
  ) => Promise<DeviceSearchAnswer | null>;
}

export function useBlendedSearch(options: {
  query: string;
  /** Context slugs from the URL. Empty means every context in reach. */
  slugs: readonly string[];
  device?: BlendedDeviceSearch | null;
}): BlendedSearchView {
  const convex = useConvex();
  const { query } = options;
  /*
    The URL's slugs, by value. The route parses them afresh on every render
    (`searchFromQuery`), and the route now re-renders whenever the console's
    data or a mirror status ticks — a download in progress ticks often. Keyed
    on the array's identity, every one of those ticks would re-send the search:
    a fan-out across several buckets per progress update.
  */
  const slugKey = options.slugs.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- by value, see above.
  const slugs = useMemo(() => options.slugs, [slugKey]);
  /*
    Through a ref, so a download's progress ticking the statuses does not
    re-send the query; whether the device is offline is a dependency, so going
    offline over a failed page answers it from the device.
  */
  const deviceRef = useRef(options.device ?? null);
  deviceRef.current = options.device ?? null;
  const offline = options.device?.reachability === "offline";

  /*
    `useQueries` rather than `useQuery`, for the reason `useLiveConsoleData`
    gives at length: a failed `useQuery` re-throws during render and would take
    the whole console down from inside a pane. A thrown context list is an
    empty one here, and the page then draws "nothing to search" — which is
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
  /*
    The query answers `{ contexts }` rather than a bare array — see
    `fastSearch.searchScopeFor`. A thrown or not-yet-landed query is `undefined`
    here (see the comment above `spec`) and defaults to empty exactly the way
    the bare array used to: an empty list draws "nothing to search", which is
    wrong but survivable, and is corrected the moment the query recovers.
  */
  const contexts = useMemo<SearchableContext[]>(() => {
    const value = answers.contexts as { contexts?: unknown } | undefined;
    return Array.isArray(value?.contexts) ? (value.contexts as SearchableContext[]) : [];
  }, [answers.contexts]);

  const [answer, setAnswer] = useState<BlendedAnswer | null>(null);
  const [results, setResults] = useState<BlendedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
  const scope = useMemo(() => scopeIds(slugs, contexts), [slugs, contexts]);
  const question = useMemo(
    // The separator is an ESCAPE, never the character: a literal NUL makes
    // git treat the file as binary, so it has no diff and cannot be
    // reviewed. What is wanted is its property — it occurs in neither half,
    // so two different questions cannot join into the same string.
    // The URL's slugs too: offline the scope comes from them rather than from
    // `scope`, which is empty there, and a chip changed while the device was
    // searching must drop that answer exactly as it would the server's.
    () => `${query.trim()}\u0000${[...scope].sort().join(",")}\u0000${[...slugs].sort().join(",")}`,
    [query, scope, slugs],
  );

  /** One page, raced against a deadline so a lost request cannot hang. */
  const ask = useCallback(
    // `Id<"workspaces">` rather than `string`, so what this forwards is the
    // type the control plane's own validator names. `scopeIds` reads the ids
    // off the context list the server sent, which is the only place a real
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
      setNotice(null);
      // The answer is kept rather than cleared, and only for `searchableCount`:
      // it is what lets an emptied field still say "nothing to search"
      // instead of falling back to "type something" for somebody who cannot.
      return;
    }

    setLoading(true);
    setFailed(false);

    /**
     * Every context in scope, from the device. The scope is the URL's slugs
     * against the console's own list — the same "empty means everything" rule
     * `toggleScope` states — because `scope` above is built from a
     * subscription that has nothing in it offline.
     */
    const fromDevice = async (local: BlendedDeviceSearch, reason: DeviceSearchReason) => {
      const inScope =
        slugs.length === 0
          ? local.contexts
          : local.contexts.filter((context) => slugs.includes(context.slug));
      const answers: DeviceSourceAnswer[] = await Promise.all(
        inScope.map(async (context) => {
          let found: DeviceSearchAnswer | null;
          try {
            found = await local.search(context, trimmed);
          } catch {
            found = null;
          }
          return {
            context: {
              workspaceId: context.workspaceId,
              slug: context.slug,
              displayName: context.displayName,
            },
            answer: found,
            status: local.statuses.get(context.workspaceId),
          };
        }),
      );
      if (asked.current !== question) return;
      setLoading(false);
      const noCopy = answers.length > 0 && answers.every((each) => each.answer === null);
      if (noCopy && reason === "unreachable") {
        // Nothing to fall back on: the request failed, and that is the page.
        setResults([]);
        setFailed(true);
        return;
      }
      const blended = blendDeviceAnswers(answers);
      setAnswer(blended);
      setResults(blended.results);
      setNotice(deviceSearchPageNotice(reason, answers));
    };

    const timer = setTimeout(() => {
      asked.current = question;
      void (async () => {
        const local = deviceRef.current;
        if (offline && local !== null) {
          await fromDevice(local, "offline");
          return;
        }
        const settled = await ask({
          query: trimmed,
          ...(scope.length > 0 ? { contexts: scope as Id<"workspaces">[] } : {}),
        });
        if (asked.current !== question) return;
        if (settled.kind === "value") {
          setLoading(false);
          setNotice(null);
          setAnswer(settled.value);
          setResults(settled.value.results);
          return;
        }
        if (local !== null) {
          await fromDevice(local, "unreachable");
          return;
        }
        setLoading(false);
        // A timeout and a rejection land together on purpose: both mean this
        // page has no answer, and what a person does about either is the same
        // — try again. The rows already on screen belong to a different
        // question, so they go.
        setResults([]);
        setFailed(true);
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [ask, query, question, scope, slugs, offline]);

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
      contexts,
      hasMore: typeof answer?.cursor === "string",
      loadingMore,
      loadMore,
      retry,
      retrying,
      notice,
    }),
    [state, results, answer, contexts, loadingMore, loadMore, retry, retrying, notice],
  );
}
