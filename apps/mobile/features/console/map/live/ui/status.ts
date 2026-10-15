import type { MapPageState } from "../hooks/useMapPage";

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
  if (page.graphs.partial.behind) return "Some recent edits aren't on the map yet. Their links fill in by themselves in a moment.";
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
