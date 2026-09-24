import { useMemo } from "react";
import { useDeviceSearch, useMirrorPaths } from "../../offline/useDeviceSearch";
import { itemsFromListings, itemsFromPaths } from "../files/palette";
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
}: {
  data: ConsoleData;
  insideContext: boolean;
  current: ConsoleContext | null;
  paletteOpen: boolean;
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
  const search = useContextSearch(insideContext ? data.files.search : null, device);
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
    () => (paletteOpen ? itemsFromPaths(mirrorPaths, itemsFromListings(listings)) : []),
    [paletteOpen, mirrorPaths, listings],
  );
  return { search, paletteItems };
}

export type PaletteSearch = ReturnType<typeof usePaletteSearch>;
