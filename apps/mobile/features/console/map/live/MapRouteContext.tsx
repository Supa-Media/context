import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ConsoleRouter } from "../../layout/types";
import { routeMap, type MapRoute } from "./route";

/**
 * The live map's address, handed down from the console layout.
 *
 * A context for What changed's reason (`OrganizerContext`): the Map button is
 * in the sidebar, the page is in the document slot, and the phone's Home and
 * back button are elsewhere again. Absent everywhere outside the console
 * layout — the homepage, the demo, every harness — and then no Map button is
 * drawn and no page can open.
 */
const MapRouteContext = createContext<MapRoute | undefined>(undefined);

export const MapRouteProvider = MapRouteContext.Provider;

export function useMapRoute(): MapRoute | undefined {
  return useContext(MapRouteContext);
}

/** The route the layout provides, stable while the URL and router are. */
export function useConsoleMapRoute(router: ConsoleRouter, open: boolean): MapRoute {
  return useMemo(() => routeMap(router, open), [router, open]);
}

/**
 * Choosing a note or folder in the tree leaves the map, as it leaves What
 * changed (`useLeavePageOnOpen`): the tree beside the map is still the way
 * into a note, and opening one should show it.
 */
export function useLeaveMapOnOpen(route: MapRoute | undefined, selectedPath: string | null): void {
  const last = useRef(selectedPath);
  const open = route?.open === true;
  const close = route?.closeMap;
  useEffect(() => {
    const changed = last.current !== selectedPath;
    last.current = selectedPath;
    if (changed && open && selectedPath !== null) close?.();
  }, [selectedPath, open, close]);
}
