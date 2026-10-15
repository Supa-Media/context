import type { MenuItem } from "../../../files/menu";
import type { MapMode, MapPageState } from "../hooks/useMapPage";
import { stretchText } from "../replayClock";
import type { Crumb } from "./breadcrumb";

/**
 * What the desktop map's controls say, apart from how they are drawn: the
 * workspace menu in the top left and the dock at the bottom (Dev2 picked the
 * bottom dock, 2026-10-14). Pure, so the words are checked without a canvas.
 */

/** The workspace menu's rows: each workspace, then every workspace at once. */
export const ALL_ID = "all";
const WORKSPACE_PREFIX = "ws:";

export const ALL_MY_WORKSPACES = "All my workspaces";

/** What the workspace menu's button says: the workspace drawn, or all of them. */
export function scopeLabel(page: Pick<MapPageState, "scope" | "many" | "selected">): string {
  if (page.scope === "all" && page.many) return ALL_MY_WORKSPACES;
  return page.selected?.displayName ?? "This workspace";
}

export function workspaceMenuItems(page: Pick<MapPageState, "scope" | "many" | "selected" | "workspaces">): MenuItem<string>[] {
  const all = page.scope === "all" && page.many;
  const rows: MenuItem<string>[] = page.workspaces.map((w) => ({
    id: `${WORKSPACE_PREFIX}${w.id}`,
    label: w.displayName,
    checked: !all && page.selected?.id === w.id,
    testID: `map-scope-ws-${w.slug}`,
  }));
  rows.push({
    id: ALL_ID,
    label: ALL_MY_WORKSPACES,
    detail: "Only the ones you belong to",
    checked: all,
    separatorBefore: true,
    testID: "map-scope-all",
  });
  return rows;
}

/** A row's id back to what it picks: a workspace by id, or every workspace. */
export function workspacePick(id: string): { kind: "all" } | { kind: "one"; workspaceId: string } {
  if (id === ALL_ID) return { kind: "all" };
  return { kind: "one", workspaceId: id.slice(WORKSPACE_PREFIX.length) };
}

/**
 * The trail after the workspace menu: "seyi ▾ › Areas". The menu already says
 * which workspace (or all of them), so the crumbs that say it again go: the
 * one that switches to every workspace, the every-workspace level, and, while
 * one workspace is drawn, that workspace's own crumb.
 */
export function trailAfterScope(crumbs: readonly Crumb[], all: boolean): Crumb[] {
  return crumbs.filter((c) => c.to !== "scope" && c.to !== "all" && (all || c.to !== "workspace"));
}

/** Replay's rows: the two rolling stretches, then a stretch of your own. */
export type ReplayChoice = Exclude<MapMode, "live">;

export function replayMenuItems(mode: MapMode): MenuItem<ReplayChoice>[] {
  return [
    { id: "day", label: "Past 24 hours", checked: mode === "day", testID: "map-when-day" },
    { id: "week", label: "Past week", checked: mode === "week", testID: "map-when-week" },
    { id: "custom", label: "Pick dates…", checked: mode === "custom", testID: "map-when-custom" },
  ];
}

/** What the Replay button says: "Replay" while live, else the stretch playing. */
export function replayLabel(page: Pick<MapPageState, "mode" | "custom">): string {
  switch (page.mode) {
    case "live":
      return "Replay";
    case "day":
      return "Past 24 hours";
    case "week":
      return "Past week";
    case "custom":
      return page.custom === null ? "Pick dates…" : stretchText(page.custom);
  }
}
