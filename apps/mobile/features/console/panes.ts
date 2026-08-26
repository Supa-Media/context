/**
 * The four panes of the console, in rail order.
 *
 * Each has a real URL. The mockup switches panes with JavaScript because it is
 * one file, but a console is somewhere people link each other to and reload —
 * "look at my storage tab" should survive being pasted into a chat.
 */
export const PANES = [
  { key: "map", label: "Map", href: "/console" },
  { key: "browse", label: "Browse", href: "/console/browse" },
  { key: "connect", label: "Connections", href: "/console/connections" },
  { key: "storage", label: "Storage", href: "/console/storage" },
] as const;

export type PaneKey = (typeof PANES)[number]["key"];

export function paneHref(key: PaneKey): string {
  return PANES.find((pane) => pane.key === key)?.href ?? "/console";
}

/** Which pane a console URL is showing. Unknown paths fall back to the map. */
export function paneForPath(pathname: string): PaneKey {
  const normalised = pathname.replace(/\/+$/, "") || "/console";
  const match = PANES.find((pane) => pane.href === normalised);
  return match?.key ?? "map";
}
