import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { browseHref } from "../nav";
import type { ConsoleRouter } from "../layout/types";

/**
 * Whether the URL has the Trash page open: `?trash=1`, beside `?note=` the way
 * the live map rides as `?map=1`, so Browse and the tree stay mounted under it
 * and Back and a shared link both find it. Anything but `1` is closed.
 */
export function trashFromQuery(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "1";
}

export function trashHref(slug: string): string {
  return `${browseHref(slug)}?trash=1`;
}

/** The Trash page's address, as the console's pieces use it. */
export interface TrashRoute {
  open: boolean;
  /** The workspace whose trash this is. */
  workspaceId: string;
  openTrash(): void;
  closeTrash(): void;
}

/** One page in the document slot at a time: opening the trash closes the map, What changed and Settings. */
export function routeTrash(router: Pick<ConsoleRouter, "setParams">, open: boolean, workspaceId: string): TrashRoute {
  return {
    open,
    workspaceId,
    openTrash: () => router.setParams({ trash: "1", map: undefined, settings: undefined }),
    closeTrash: () => router.setParams({ trash: undefined }),
  };
}

/**
 * Handed down from the console layout, for the map's reason (`MapRouteContext`):
 * the Trash row is in the sidebar and on a phone's Home, the page in the
 * document slot. Absent outside the console layout (the homepage, the demo, a
 * visitor), and then no Trash row is drawn and no page can open.
 */
const TrashRouteContext = createContext<TrashRoute | undefined>(undefined);

export const TrashRouteProvider = TrashRouteContext.Provider;

export function useTrashRoute(): TrashRoute | undefined {
  return useContext(TrashRouteContext);
}

/** The route the layout provides, and choosing a note or folder in the tree leaves it, as it leaves the map. */
export function useConsoleTrashRoute(
  router: ConsoleRouter,
  open: boolean,
  { available, workspaceId, selectedPath }: { available: boolean; workspaceId: string | null; selectedPath: string | null },
): TrashRoute | undefined {
  const route = useMemo(
    () => (available && workspaceId !== null ? routeTrash(router, open, workspaceId) : undefined),
    [available, router, open, workspaceId],
  );
  const last = useRef(selectedPath);
  const close = route?.closeTrash;
  useEffect(() => {
    const changed = last.current !== selectedPath;
    last.current = selectedPath;
    if (changed && open && selectedPath !== null) close?.();
  }, [selectedPath, open, close]);
  return route;
}
