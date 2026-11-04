import type { FolderPlace, NotePlace } from "../layout";
import { BOW, bowOf, grain } from "./board";
import type { DrawEnv } from "./env";

/**
 * "Which lines" and "One line between folders" in the map's settings (Dev2,
 * 2026-11-04): every link, only those near the pointer, or only the hovered
 * note's; and far out, the links between two folders gathered into one
 * pencil stroke, thicker for more.
 */

/** How close to the pointer a link's end must be for "Lines near the cursor", in pixels. */
export const NEAR_PX = 160;

/** Which links the person's "Which lines" lets through: all, near the pointer, or the hovered note's. */
export function linesShown(env: DrawEnv): (a: NotePlace, b: NotePlace) => boolean {
  const lines = env.style.look.lines;
  const ptr = env.pointer;
  // No pointer to follow (a phone, or before the mouse arrives): every line.
  if (lines === "all" || ptr === undefined) return () => true;
  if (lines === "hover") {
    const key = env.hoverKey;
    return (a, b) => key !== null && (a.key === key || b.key === key);
  }
  if (ptr === null) return () => false;
  const near = (n: NotePlace) => {
    const p = env.screen(n);
    return Math.hypot(p.x - ptr.x, p.y - ptr.y) < NEAR_PX;
  };
  return (a, b) => near(a) || near(b);
}

/** Bundled links between folders: one bowed pencil stroke per pair, thicker for more links. */
export function drawBundles(env: DrawEnv, bundles: Map<string, { a: FolderPlace; b: FolderPlace; n: number }>, alpha: number): void {
  const { ctx, style } = env;
  const C = style.palette;
  ctx.strokeStyle = grain(ctx, C, C.edge);
  ctx.lineCap = "round";
  for (const { a, b, n } of bundles.values()) {
    const p = env.screen(a);
    const q = env.screen(b);
    const bow = bowOf(a.x, a.y, b.x, b.y) * BOW * 2;
    ctx.globalAlpha = Math.min(0.85, alpha * (0.35 + Math.log2(1 + n) * 0.12));
    ctx.lineWidth = Math.min(6, 0.8 + Math.log2(1 + n) * 0.9) * style.look.lineWidth * 1.6;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.quadraticCurveTo((p.x + q.x) / 2 - (q.y - p.y) * bow, (p.y + q.y) / 2 + (q.x - p.x) * bow, q.x, q.y);
    ctx.stroke();
  }
  ctx.lineCap = "butt";
  ctx.lineWidth = 1;
  ctx.globalAlpha = 1;
}

