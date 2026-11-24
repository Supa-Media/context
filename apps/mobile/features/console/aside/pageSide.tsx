import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

/**
 * What a page puts in the console's right panel: the Areas page's area,
 * pressed once (the owner, 2026-11-24: "just put it in the left panel like
 * this", of the right panel where Meetings is drawn). While a page offers
 * one, the panel gains its Area tab, which comes forward, and the panel opens
 * if it was shut.
 *
 * The page owns the content and the panel owns where it goes, as with the
 * live map's tabs (`mapSide.tsx`). With no store (a harness that mounts a
 * page without a console), `useOfferPageSide` answers false and the page
 * draws the panel beside its own list instead.
 */
export type PageSide = ReactNode;

export type PageSideStore = {
  get: () => PageSide | null;
  set: (side: PageSide | null) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createPageSideStore(): PageSideStore {
  let side: PageSide | null = null;
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

const PageSideContext = createContext<PageSideStore | null>(null);

/** One store for one console; the provider makes it. */
export function PageSideProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => createPageSideStore(), []);
  return <PageSideContext.Provider value={store}>{children}</PageSideContext.Provider>;
}

const nothing = () => null;
const never = () => () => {};

/** What a page offers the panel, or null. */
export function usePageSide(): PageSide | null {
  const store = useContext(PageSideContext);
  return useSyncExternalStore(store?.subscribe ?? never, store?.get ?? nothing, store?.get ?? nothing);
}

/**
 * Offer `side` to the panel while it is not null, and take it back when it is
 * or the page goes. True where a console provides the panel.
 */
export function useOfferPageSide(side: PageSide | null): boolean {
  const store = useContext(PageSideContext);
  useLayoutEffect(() => {
    store?.set(side);
  }, [store, side]);
  useEffect(() => () => store?.set(null), [store]);
  return store !== null;
}
