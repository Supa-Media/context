import { browseHref } from "../../nav";
import type { ConsoleRouter } from "../../layout/types";

/**
 * Whether the URL has the live map open: `?map=1`, beside `?note=` the way
 * What changed rides as `?changes=1`, so Browse and the tree stay mounted under
 * it and Back and a shared link both find it. Anything but `1` is closed.
 *
 * This is the workspace map the sidebar's Map button opens. The old
 * `/console/map` constellation route is a different page and is left alone.
 */
export function mapFromQuery(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "1";
}

export function mapHref(slug: string): string {
  return `${browseHref(slug)}?map=1`;
}

/** The map's address, as the console's pieces use it. */
export interface MapRoute {
  open: boolean;
  openMap(): void;
  closeMap(): void;
  /** The sidebar button: open when closed, closed when open. */
  toggle(): void;
}

/**
 * The map is one page in the document slot at a time with What changed and
 * Settings, so opening it closes both; closing it clears only its own key.
 */
export function routeMap(router: Pick<ConsoleRouter, "setParams">, open: boolean): MapRoute {
  const openMap = () => router.setParams({ map: "1", changes: undefined, settings: undefined });
  const closeMap = () => router.setParams({ map: undefined });
  return { open, openMap, closeMap, toggle: () => (open ? closeMap() : openMap()) };
}
