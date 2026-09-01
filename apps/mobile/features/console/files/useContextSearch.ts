/**
 * Searching the whole context from the console, rather than filtering the
 * folders somebody happened to expand.
 *
 * The palette was a file picker wearing a magnifying glass: it ranked the
 * listings the browser had already loaded, and said so — "only folders you
 * have opened are searched". For a person looking up a name they wrote down
 * months ago, that is a miss on the one question search exists to answer, and
 * an honest message about it does not make it less of a miss.
 *
 * This asks `functions/files.searchContext`, which runs the gateway's own
 * indexed search over the customer's bucket. Four consequences worth knowing:
 *
 *  - **It costs a round trip and touches storage**, so the query is debounced
 *    and short queries are never sent. Every keystroke reaching the bucket
 *    would spend somebody's request quota on prefixes of a word.
 *  - **It can be behind.** The index is a derivative that catches up over
 *    successive calls, and a context that has never been searched has none at
 *    all. `indexing` is reported as its own state, never as "no matches".
 *  - **Answers can arrive out of order.** Each request records the query it
 *    was for and a later answer for an earlier query is dropped, so a fast
 *    reply to "ike" cannot overwrite the results for "ikenna".
 *  - **It can fail to arrive at all**, and that has to end. `searchContext` is
 *    a Convex action, and `ConvexReactClient.action()` has no client-side
 *    timeout — the same property `features/offline` exists around — so a
 *    request lost to a dead uplink leaves "Searching the rest of this
 *    context…" on screen with nothing behind it and no way out but retyping.
 *    A spinner that cannot stop is the one state a person cannot act on.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SearchAnswer } from "./browser";
import type { PaletteItem } from "./palette";
import { parentPath } from "./paths";
import { raceTimeout } from "../storage/timeout";

/**
 * Below this, a query is a prefix of a word rather than a word, and the
 * results are noise bought with a round trip. The local filename filter keeps
 * answering underneath — a two-letter query is exactly what that half is good
 * at.
 */
const MIN_QUERY = 3;

/**
 * Long enough that typing a name does not send its prefixes, short enough that
 * the results feel like they belong to what is on screen.
 */
const DEBOUNCE_MS = 250;

/**
 * How long to wait for an answer before saying we stopped waiting.
 *
 * A search reads a ready index: a manifest, the shards the query's terms are
 * in, and the notes it quotes — a handful of round trips against the customer's
 * bucket, plus the one listing a miss over a converged index is allowed to buy.
 * Ten seconds is far past all of that and short enough that a palette does not
 * hold a spinner nobody can dismiss. It is the same order as the per-request
 * deadline the control plane puts on the customer's endpoint, which is what
 * would end a hung search from the other side if the request got that far.
 */
export const SEARCH_TIMEOUT_MS = 10_000;

export type SearchState = "idle" | "searching" | "ready" | "indexing" | "failed";

export interface ContextSearch {
  onQuery: (query: string) => void;
  items: PaletteItem[];
  state: SearchState;
}

type SearchHit = SearchAnswer["hits"][number];

/** A hit as a palette row: the note's own title, over where it lives. */
export function itemsFromHits(hits: SearchHit[]): PaletteItem[] {
  return hits.map((hit) => {
    const folder = parentPath(hit.path);
    // The first matching line, when the search found one — the reason this row
    // is here, which a folder path alone never shows. Trimmed hard: a palette
    // row is one line, and a snippet that wraps pushes the next result off a
    // phone screen.
    const snippet = hit.snippets[0]?.trim();
    return {
      id: hit.path,
      label: hit.title,
      detail: snippet ? `${folder === "" ? "" : `${folder} · `}${snippet}`.slice(0, 120) : folder,
      kind: "note" as const,
    };
  });
}

/**
 * @param search the browser's own `search`, or `null` where there is nothing
 *   to search — an all-contexts route has no single bucket to ask.
 */
export function useContextSearch(
  search: ((query: string) => Promise<SearchAnswer>) | null,
): ContextSearch {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PaletteItem[]>([]);
  const [state, setState] = useState<SearchState>("idle");

  /** The query the newest request was for; older answers are ignored. */
  const latest = useRef("");

  useEffect(() => {
    const trimmed = query.trim();
    if (search === null || trimmed.length < MIN_QUERY) {
      latest.current = trimmed;
      setItems([]);
      setState("idle");
      return;
    }

    setState("searching");
    const timer = setTimeout(() => {
      latest.current = trimmed;
      void (async () => {
        // Raced rather than awaited, so a request that never settles ends as a
        // stated failure instead of a permanent spinner. A late answer is
        // dropped rather than shown: `raceTimeout` settles once, and the query
        // check below drops it again if the person has typed since.
        const settled = await raceTimeout(
          // Called inside the race so a `search()` that throws synchronously is
          // a rejected promise here rather than an exception out of the effect.
          (async () => await search(trimmed))(),
          {
            ms: SEARCH_TIMEOUT_MS,
            schedule: (fn, ms) => setTimeout(fn, ms),
            cancel: (handle) => clearTimeout(handle),
          },
        );
        if (latest.current !== trimmed) return;
        if (settled.kind === "value") {
          const hits = itemsFromHits(settled.value.hits);
          setItems(hits);
          // An empty answer from an index that is still catching up is not an
          // answer about somebody's notes. With hits on screen the caveat is
          // not worth a state of its own — the rows are real either way — but
          // with none, "nothing matches" would be exactly the claim this
          // feature exists to stop making.
          const behind =
            settled.value.indexMissing || (settled.value.indexIncomplete && hits.length === 0);
          setState(behind ? "indexing" : "ready");
          return;
        }
        // A failure and a timeout land in the same place on purpose: both mean
        // this half of the palette has no answer, and the copy already says
        // only the loaded folders were filtered. Deliberately not an error
        // dialog either — the local filter is still filtering, so the palette
        // went from "better" back to what it was, and a modal over a working
        // list is worse than a line of text.
        setItems([]);
        setState("failed");
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, search]);

  const onQuery = useCallback((next: string) => setQuery(next), []);

  return useMemo(() => ({ onQuery, items, state }), [onQuery, items, state]);
}
