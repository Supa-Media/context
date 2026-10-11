import { useCallback, useMemo, useRef, useState } from "react";
import type { PaletteSearch } from "../../design/components/Palette";
import { useBlendedSearch, type BlendedDeviceSearch } from "../search/useBlendedSearch";
import type { SearchableContext } from "../search/results";
import {
  itemsFromBlended,
  parseScopedQuery,
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
 * "@name " in front of the words.
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
  /** The workspace the search is narrowed to, by chip or by "@name ", or `null` for all of them. */
  narrowed: string | null;
  /** Pick a chip; `null` is "All workspaces". */
  narrow: (slug: string | null) => void;
  /** Whether the narrowing came from "@name " in the field, which only the field can undo. */
  typedScope: boolean;
  /** What the pill and its panel draw, or `null` before anything has answered. */
  timing: TimingBreakdown | null;
  /** Whether the pill belongs to the words on screen, rather than a search still running. */
  settled: boolean;
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
  const [raw, setRaw] = useState("");
  const [chip, setChip] = useState<string | null>(null);
  const onQuery = useCallback((next: string) => setRaw(next), []);

  /*
    The slugs come from the blended search's own list, a subscription that
    arrives a render after the first; until it does "@supa " is searched for
    as written, and its arrival re-renders this hook, which then narrows.
    Read through a ref because the list is the blended search's answer and
    the blended search needs the parsed query to ask.
  */
  const slugs = useRef<readonly string[]>([]);
  const typed = parseScopedQuery(raw, slugs.current);
  const narrowed = typed.slug ?? chip;
  const blended = useBlendedSearch({
    query: enabled ? typed.query : "",
    slugs: narrowed === null ? [] : [narrowed],
    device,
  });
  slugs.current = blended.contexts.map((context) => context.slug);

  const items = useMemo(
    () => itemsFromBlended(blended.results, typed.query, currentSlug),
    [blended.results, typed.query, currentSlug],
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
    narrow: setChip,
    typedScope: typed.slug !== null,
    timing: useMemo(() => timingBreakdown(blended.answer, blended.took), [blended.answer, blended.took]),
    settled: blended.state !== "searching" && blended.state !== "idle",
  };
}
