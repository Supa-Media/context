import type { Rect } from "./labels";

/**
 * What is under a point. Every render records the shapes it drew in screen
 * pixels, in a `HitFrame`, and a click asks the frame rather than re-deriving
 * the layout, so what you can click is exactly what you can see.
 */

export type HitTarget =
  | { kind: "actor"; id: string }
  | { kind: "pile"; ids: string[] }
  | { kind: "note"; workspaceId: string; path: string }
  | { kind: "folder"; workspaceId: string; path: string }
  | { kind: "workspace"; workspaceId: string };

type Circle = { x: number; y: number; r: number };

export type HitShape =
  | (Circle & { target: HitTarget; layer: number })
  | { rect: Rect; target: HitTarget; layer: number };

/** Higher layers win: a face over a name over a dot over a bubble. */
export const LAYER = { workspace: 0, folder: 1, sub: 2, note: 3, label: 4, card: 4, pile: 5, actor: 6 } as const;

export class HitFrame {
  readonly shapes: HitShape[] = [];

  circle(x: number, y: number, r: number, target: HitTarget, layer: number): void {
    this.shapes.push({ x, y, r, target, layer });
  }

  rect(rect: Rect, target: HitTarget, layer: number): void {
    this.shapes.push({ rect, target, layer });
  }
}

/**
 * The top thing at (x, y), with a little slack for fingers on small dots.
 * Among shapes on one layer the nearest centre wins, then the latest drawn.
 */
export function hitTest(frame: HitFrame, x: number, y: number, slack = 4): HitTarget | null {
  let best: HitShape | null = null;
  let bestD = Infinity;
  for (const shape of frame.shapes) {
    let d: number;
    if ("rect" in shape) {
      const r = shape.rect;
      if (x < r.x - slack || x > r.x + r.w + slack || y < r.y - slack || y > r.y + r.h + slack) continue;
      d = Math.hypot(x - (r.x + r.w / 2), y - (r.y + r.h / 2)) / 1000;
    } else {
      const dd = Math.hypot(x - shape.x, y - shape.y);
      // Bubbles take no slack (they are big); dots and faces do.
      const allow = shape.layer <= LAYER.sub ? shape.r : shape.r + slack;
      if (dd > allow) continue;
      d = dd / Math.max(1, shape.r);
    }
    if (!best || shape.layer > best.layer || (shape.layer === best.layer && d <= bestD)) {
      best = shape;
      bestD = d;
    }
  }
  return best ? best.target : null;
}
