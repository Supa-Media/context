import type { Cam, Viewport } from "../camera";
import type { HitFrame } from "../hit";
import type { Bounds, Occupancy } from "../labels";
import type { Point } from "../math";
import type { Model, SceneAt } from "../scene";
import type { Ctx, Style } from "./primitives";

/** Everything one map frame's drawing passes share. */
export type DrawEnv = {
  ctx: Ctx;
  style: Style;
  model: Model;
  scene: SceneAt;
  cam: Cam;
  vp: Viewport;
  s: number;
  screen: (p: Point) => Point;
  /** Roughly on screen, with `margin` pixels to spare. */
  onScreen: (p: Point, margin: number) => boolean;
  hit: HitFrame;
  occ: Occupancy;
  /** Where text may go: the visible rect, a little inset. */
  bounds: Bounds;
  /** Phone-width: drop what does not fit rather than overlap. */
  narrow: boolean;
  /** Following someone: everything they are not touching steps back. */
  dim: boolean;
  /** A selected note, drawn teal. */
  selected: string | null;
  /** Notes present per folder and subfolder key, and per workspace. */
  counts: Map<string, number>;
  /** Note keys that are hot: written, read, followed, new or selected. */
  hot: Set<string>;
};

/** Notes present under each folder, subfolder and workspace at this instant. */
export function countPresent(model: Model, scene: SceneAt): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const key of scene.present) {
    const n = model.layout.notes.get(key);
    if (!n) continue;
    bump(n.sub.key);
    bump(n.sub.folder.key);
    bump(n.workspaceId);
  }
  return counts;
}
