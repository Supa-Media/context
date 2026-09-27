import { useMemo } from "react";
import { useDeviceSearch, useMirrorPaths } from "../../offline/useDeviceSearch";
import { recentPaths, type HistoryState } from "../files/history";
import { itemsFromListings, itemsFromPaths, recentItems, type NoteNaming } from "../files/palette";
import { useContextSearch } from "../files/useContextSearch";
import type { ConsoleContext, ConsoleData } from "../types";

/**
 * What the ⌘K palette searches and lists: the whole context through the
 * bucket or the device's mirror, and the loaded names. Lifted out of the
 * console layout whole, in the order its hooks always ran.
 */
export function usePaletteSearch({
  data,
  insideContext,
  current,
  paletteOpen,
  history,
}: {
  data: ConsoleData;
  insideContext: boolean;
  current: ConsoleContext | null;
  paletteOpen: boolean;
  /** Where this context has been, for what an untyped search lists. */
  history?: HistoryState;
}) {
  /*
    Whole-context search, behind the same palette that filters what is loaded.
    `null` while no context is selected — an all-contexts route has no single
    bucket to ask, so the palette falls back to filtering listings, which is
    what it did everywhere before this.
  */
  /*
    …and the same search over the copy of this context on the device, which
    answers when the device is offline or the bucket does not — see
    `useContextSearch` for when, and `mirrorSearch.ts` for what it reads.
  */
  const deviceSearch = useDeviceSearch(insideContext ? (current?.id ?? null) : null, current?.role);
  const reachability = data.files.sync?.reachability ?? "unknown";
  const mirrorStatus = data.files.sync?.mirror;
  const device = useMemo(
    () =>
      deviceSearch === null
        ? null
        : { reachability, status: mirrorStatus, search: deviceSearch },
    [deviceSearch, reachability, mirrorStatus],
  );
  const searched = useContextSearch(insideContext ? data.files.search : null, device);
  /*
    Rows named the way the note is: its title from the bodies the browser
    holds, and the workspace's own name for the top of it ("@context" on the
    homepage) rather than a lone `/`.
  */
  const heldNotes = data.files.heldNotes;
  const root = current?.displayName;
  const naming = useMemo<NoteNaming>(
    () => ({ texts: heldNotes, ...(root === undefined ? {} : { root }) }),
    [heldNotes, root],
  );
  const search = useMemo(
    () =>
      root === undefined
        ? searched
        : {
            ...searched,
            items: searched.items.map((item) =>
              item.kind === "note" && item.detail === undefined ? { ...item, detail: root } : item,
            ),
          },
    [searched, root],
  );
  /*
    Quick open by name, offline, over every note the mirror holds rather than
    only the folders that had been expanded before the signal went.
  */
  const mirrorPaths = useMirrorPaths(
    insideContext ? (current?.id ?? null) : null,
    current?.role,
    paletteOpen && reachability === "offline",
  );
  const listings = data.files.listings;
  const paletteItems = useMemo(
    () => (paletteOpen ? itemsFromPaths(mirrorPaths, itemsFromListings(listings, naming), naming) : []),
    [paletteOpen, mirrorPaths, listings, naming],
  );
  /* An untyped search lists the notes somebody was just in. */
  const recent = useMemo(
    () =>
      paletteOpen && history !== undefined && insideContext
        ? recentItems(recentPaths(history), paletteItems, naming)
        : [],
    [paletteOpen, history, insideContext, paletteItems, naming],
  );
  return { search, paletteItems, recent };
}

export type PaletteSearch = ReturnType<typeof usePaletteSearch>;
