import type { MapPageState } from "../hooks/useMapPage";

/** The two hints under the map; the second only where several workspaces are drawn. */
export const ZOOM_HINT = "Scroll or pinch to zoom · double-click a folder to dive in";
export const MEMBERSHIP_HINT = "You only see workspaces you belong to";

/** What the map cannot draw yet, said over it rather than left as an empty canvas. */
export function mapNotice(page: Pick<MapPageState, "graphs" | "historyLoading" | "data">): string | null {
  if (page.graphs.loading && page.graphs.graphs.length === 0) return "Drawing the map…";
  if (page.historyLoading) return "Gathering what happened…";
  // Before the empty check: a workspace with no index yet has no notes to give, and is not empty.
  if (page.graphs.partial.indexMissing) return "This workspace's map is still being built.";
  const notes = page.data.graphs.reduce((n, g) => n + g.nodes.length, 0);
  if (notes === 0) return "No notes to draw here yet.";
  const cut = cutNotice(page.graphs.partial);
  if (cut !== null) return cut;
  if (page.graphs.partial.behind) return "The map is catching up with the latest changes.";
  return null;
}

/**
 * What a size limit left off the map, in numbers. Notes first: every folder is
 * still drawn, and the biggest show part of what is in them. Links second,
 * since every note is there and only some lines between them are not.
 */
export function cutNotice(partial: MapPageState["graphs"]["partial"]): string | null {
  if (!partial.truncated) return null;
  if (partial.total > partial.drawn) {
    const drawn = partial.drawn.toLocaleString("en-US");
    const total = partial.total.toLocaleString("en-US");
    return `Showing ${drawn} of ${total} notes so the map stays readable. Every folder is here; the biggest show part of what's in them.`;
  }
  if (partial.linksCut) return "Every note is here, but some links between them aren't drawn: there are too many to show at once.";
  return "This map is showing part of this workspace.";
}

/** "Map · Supa · 412 notes", and the hints for what the pointer can do. */
export function statusParts(page: Pick<MapPageState, "data" | "follow" | "view" | "scope" | "many" | "selected" | "events" | "t">): {
  left: string[];
  right: string[];
} {
  const view = page.view === "folders" ? "Folders" : "Map";
  const notes = page.data.graphs.reduce((n, g) => n + g.nodes.length, 0);
  const all = page.scope === "all" && page.many;
  const where = all ? "All workspaces" : (page.selected?.displayName ?? "This workspace");
  const detail =
    page.follow !== null
      ? `Following ${page.follow.name}`
      : page.view === "folders"
        ? `Moved today: ${movedToday(page.events, page.t)}`
        : `${where} · ${notes.toLocaleString("en-US")} ${notes === 1 ? "note" : "notes"}`;
  // Folders is a fixed layout with nothing to zoom, so the hint is the map's alone.
  const zoom = page.view === "folders" ? [] : [ZOOM_HINT];
  return { left: [view, detail], right: all ? [MEMBERSHIP_HINT, ...zoom] : zoom };
}

function movedToday(events: MapPageState["events"], t: number): number {
  const day = new Date(t);
  day.setHours(0, 0, 0, 0);
  return events.filter((e) => e.kind === "move" && e.at >= day.getTime() && e.at <= t).length;
}
