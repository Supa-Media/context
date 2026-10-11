import type { CameraDetail } from "../engine";
import type { ZoomLevel } from "../types";

const ORDER: ZoomLevel[] = ["all", "workspace", "folders", "notes"];

/** The levels this camera can stop at, far to near: the trail's crumbs map onto these in order. */
export function levelsOf(camera: Pick<CameraDetail, "stops">): ZoomLevel[] {
  return ORDER.filter((level) => camera.stops[level] !== undefined);
}

/** One crumb: what it says, and where pressing it goes. */
export type Crumb = {
  name: string;
  /** A level to zoom to, or "scope": show every workspace, from one. */
  to: ZoomLevel | "scope";
};

export const ALL_WORKSPACES = "All workspaces";

/**
 * The breadcrumb, far to near: "All workspaces › Personal › Projects". The
 * engine's trail names the levels this camera can reach. Showing one workspace
 * of several, the camera has no "all" level, so the first crumb is added here
 * and switches the map to every workspace; a person with one workspace has no
 * "All workspaces" to go back to and gets no such crumb.
 */
export function crumbsOf(camera: Pick<CameraDetail, "trail" | "stops">, many: boolean): Crumb[] {
  const levels = levelsOf(camera);
  const crumbs: Crumb[] = [];
  camera.trail.forEach((name, i) => {
    const level = levels[i];
    if (level !== undefined) crumbs.push({ name, to: level });
  });
  if (many && levels[0] !== "all" && crumbs.length > 0) crumbs.unshift({ name: ALL_WORKSPACES, to: "scope" });
  if (!many && crumbs[0]?.to === "all") crumbs.shift();
  return crumbs;
}
