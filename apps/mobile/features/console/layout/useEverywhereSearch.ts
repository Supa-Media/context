import { useCallback, useMemo, useRef, useState } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { PaletteItem } from "../files/palette";
import type { PaletteSearch } from "../../design/components/Palette";
import { useBlendedSearch, type BlendedDeviceSearch } from "../search/useBlendedSearch";
import type { SearchableContext } from "../search/results";
import { workspaceFilters } from "./searchFilters";
import type { PaletteFilters } from "../../design/components/PaletteFilterTokens";
import {
  itemsFromNames,
  itemsFromBlended,
  paletteStateOf,
  sourcesNotice,
  timingBreakdown,
  type TimingBreakdown,
} from "./everywhereSearch";

/**
 * ⌘K's search of every workspace, unless somebody narrows it to one.
 *
 * Dev2 (2026-10-09): "by default it should search all workspaces unless we know
 * for a fact that we want to only search a specific workspace". So this is the
 * search page's own blended search (`useBlendedSearch`: one request across
 * every workspace, debounced, stale answers dropped, bounded, answered from the
 * device's copies offline) behind the palette, narrowed by a chip or by typing
 * `in:` and picking a workspace (`searchFilters.ts`).
 *
 * `enabled` false asks nothing: the palette is closed, a folder narrowed it to
 * one workspace's subtree (which `useContextSearch` already serves), or this is
 * a visitor, who has no workspaces to fan out over.
 */
export interface EverywhereSearch {
  /** The palette's half: rows in the server's order, and `ranked` so it keeps that order. */
  search: PaletteSearch;
  /** Every workspace this person can search, for the chips. */
  contexts: readonly SearchableContext[];
  /** The workspace the search is narrowed to, by chip or by `in:`, or `null` for all of them. */
  narrowed: string | null;
  /** Pick a chip; `null` is "All workspaces". */
  narrow: (slug: string | null) => void;
  /** `in:` for the palette's field, or `undefined` with only one workspace to search. */
  filters: PaletteFilters | undefined;
  /** What the pill and its panel draw, or `null` before anything has answered. */
  timing: TimingBreakdown | null;
  /** Whether the pill belongs to the words on screen, rather than a search still running. */
  settled: boolean;
  /**
   * Notes whose names hold what was typed, from the tree, in every workspace
   * (or the one narrowed to), from the first letter (board M1). Ranked with
   * the loaded names, so a note in a folder nobody opened is offered at once.
   */
  names: PaletteItem[];
}

export function useEverywhereSearch({
  enabled,
  currentSlug,
  device,
}: {
  enabled: boolean;
  /** The workspace being browsed, whose results open in place. */
  currentSlug: string | null;
  device: BlendedDeviceSearch | null;
}): EverywhereSearch {
  // The palette sends only the words: a filter is picked out of the field into `narrowed`.
  const [query, setQuery] = useState("");
  const [narrowed, narrow] = useState<string | null>(null);
  const onQuery = useCallback((next: string) => setQuery(next), []);
  const blended = useBlendedSearch({
    query: enabled ? query : "",
    slugs: narrowed === null ? [] : [narrowed],
    device,
  });

  /*
    Live, and asked from the first letter: a query rather than the search's
    action, so it is one cheap read of the tree per keystroke, never a fan-out
    across buckets. The last answer stays drawn while the next one loads, so
    the names do not blink between letters.
  */
  const narrowedId = blended.contexts.find((context) => context.slug === narrowed)?.workspaceId ?? null;
  const asked = enabled ? query.trim() : "";
  const nameSpec = useMemo<RequestForQueries>(() => {
    const spec: RequestForQueries = {};
    if (asked === "") return spec;
    spec.names = {
      query: api.functions.nameSearch.searchNames,
      args: { query: asked, ...(narrowedId === null ? {} : { contexts: [narrowedId as Id<"workspaces">] }) },
    };
    return spec;
  }, [asked, narrowedId]);
  const nameAnswer = useQueries(nameSpec).names as unknown;
  const lastNames = useRef<PaletteItem[]>([]);
  const names = useMemo(() => {
    if (asked === "") return (lastNames.current = []);
    // A thrown query is an `Error` here (`useQueries`), and is no names.
    if (!Array.isArray(nameAnswer)) return nameAnswer === undefined ? lastNames.current : [];
    return (lastNames.current = itemsFromNames(nameAnswer, currentSlug));
  }, [asked, nameAnswer, currentSlug]);

  const items = useMemo(
    () => itemsFromBlended(blended.results, query, currentSlug),
    [blended.results, query, currentSlug],
  );
  const state = paletteStateOf(blended.state, blended.answer);
  const notice = blended.notice ?? sourcesNotice(blended.answer);
  const search = useMemo<PaletteSearch>(
    () => ({
      onQuery,
      items,
      state,
      notice,
      ranked: true,
      heading: "Every workspace",
      searchingText: narrowed === null ? "Searching every workspace…" : `Searching @${narrowed}…`,
      emptyMessage:
        narrowed === null
          ? "Nothing in any workspace matches that. Try fewer words, or a word you would have written down."
          : `Nothing in @${narrowed} matches that. Pick “All workspaces” to search the rest.`,
    }),
    [onQuery, items, state, notice, narrowed],
  );

  return {
    search,
    contexts: blended.contexts,
    narrowed,
    narrow,
    filters: useMemo(() => workspaceFilters(blended.contexts, narrowed, narrow), [blended.contexts, narrowed]),
    timing: useMemo(() => timingBreakdown(blended.answer, blended.took), [blended.answer, blended.took]),
    settled: blended.state !== "searching" && blended.state !== "idle",
    names,
  };
}
