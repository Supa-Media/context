import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

/**
 * What the live map puts in the console's right panel (Dev2, 2026-11-04:
 * "merge it with the meetings side bar"). While the map is open, the panel
 * gains its Activity tab and, with a note clicked, its Note tab, beside
 * Meetings; the top bar's panel button hides all of it at once.
 *
 * The map owns this content and the panel owns where it goes, so the map
 * hands its two tabs up through a small store the console provides, and the
 * panel reads them. With no store (a harness that mounts the map without a
 * console), the map keeps its own column (`useMapSideStore` is null).
 */
export type MapSide = {
  /** Who is working and what is happening: the Activity tab. */
  activity: ReactNode;
  /** The clicked note's preview, or null with none clicked. */
  note: ReactNode;
  /** Which note is clicked, so a new click brings the Note tab forward. */
  noteKey: string | null;
};

export type MapSideStore = {
  get: () => MapSide | null;
  set: (side: MapSide | null) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createMapSideStore(): MapSideStore {
  let side: MapSide | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => side,
    set: (next) => {
      if (next === side) return;
      side = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const MapSideContext = createContext<MapSideStore | null>(null);

/** One store for one console; the provider makes it. */
export function MapSideProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => createMapSideStore(), []);
  return <MapSideContext.Provider value={store}>{children}</MapSideContext.Provider>;
}

export function useMapSideStore(): MapSideStore | null {
  return useContext(MapSideContext);
}

const nothing = () => null;
const never = () => () => {};

/** The map's tabs for the panel, or null while the map is not open. */
export function useMapSide(): MapSide | null {
  const store = useMapSideStore();
  return useSyncExternalStore(store?.subscribe ?? never, store?.get ?? nothing, store?.get ?? nothing);
}

/**
 * Offer the map's tabs to the panel, each render, and take them back when the
 * map closes. `side` null, or no store, offers nothing.
 */
export function useOfferMapSide(side: MapSide | null): void {
  const store = useMapSideStore();
  useLayoutEffect(() => {
    store?.set(side);
  });
  useEffect(() => () => store?.set(null), [store]);
}
