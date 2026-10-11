import { LAYER } from "../hit";
import type { Rect } from "../labels";
import { dotRadius } from "../lod";
import type { Flight } from "../scene";
import type { DrawEnv } from "./env";
import { circle, drawCard, drawFace, fillText, fontOf, roundRect } from "./primitives";

/**
 * Notes in flight. Inside a workspace a moved note is an ink dot on its arc
 * (the trail is drawn with the links). Between workspaces it is a card with
 * its mover's face at the leading corner and a caption — "Seyi is moving it
 * to Supa › Projects" — that goes wherever beside the card is free: under it,
 * to its right, to its left, above. On a phone a caption with nowhere free is
 * dropped; on a desktop it stays under the card.
 */

export type FlightCaption = { text: string; rect: Rect };

const CHIP_H = 30;

/** The card's rect at this instant. */
function chipRect(env: DrawEnv, fl: Flight): Rect {
  const p = env.screen(fl.pos);
  env.ctx.font = fontOf(env.style, 13, 500);
  const w = Math.min(280, env.ctx.measureText(fl.to.title).width + 50);
  return { x: p.x - w / 2, y: p.y - CHIP_H / 2, w, h: CHIP_H };
}

const captionText = (fl: Flight): string =>
  `${fl.actor.name} is moving it to ${fl.to.sub.folder.island.name} › ${fl.to.sub.folder.label || "the top level"}`;

/** Claim each flying card and find its caption a free spot. Call after faces, before flags. */
export function placeFlights(env: DrawEnv): Map<Flight, FlightCaption | null> {
  const out = new Map<Flight, FlightCaption | null>();
  const { ctx, style } = env;
  for (const fl of env.scene.flights) {
    if (!fl.cross || fl.landedFor >= 0) continue;
    const chip = chipRect(env, fl);
    // The card and the face on its corner.
    env.occ.claim({ x: chip.x - 18, y: chip.y - 14, w: chip.w + 22, h: chip.h + 18 });
    const text = captionText(fl);
    ctx.font = fontOf(style, 11, 500);
    const w = ctx.measureText(text).width + 14;
    const h = 20;
    const cx = chip.x + chip.w / 2;
    const cy = chip.y + chip.h / 2;
    const spots: Rect[] = [
      { x: cx - w / 2, y: chip.y + chip.h + 4, w, h },
      { x: chip.x + chip.w + 8, y: cy - h / 2, w, h },
      { x: chip.x - 22 - w, y: cy - h / 2, w, h },
      { x: cx - w / 2, y: chip.y - 18 - h, w, h },
    ];
    let placed: Rect | null = null;
    for (const r of spots) {
      if (env.occ.tryClaim(r, env.bounds)) {
        placed = r;
        break;
      }
    }
    if (!placed && !env.narrow) {
      placed = spots[0]!;
      env.occ.claim(placed);
    }
    out.set(fl, placed ? { text, rect: placed } : null);
  }
  return out;
}

export function drawFlights(env: DrawEnv, captions: Map<Flight, FlightCaption | null>): void {
  const { ctx, style, scene, s } = env;
  const C = style.palette;
  for (const fl of scene.flights) {
    const p = env.screen(fl.pos);
    if (fl.landedFor < 0) {
      if (fl.cross) {
        const r = chipRect(env, fl);
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.2)";
        ctx.shadowBlur = 14;
        ctx.shadowOffsetY = 6;
        roundRect(ctx, r.x, r.y, r.w, r.h, 8);
        ctx.fillStyle = C.ground;
        ctx.fill();
        ctx.restore();
        drawCard(ctx, style, r.x, r.y, r.w, fl.to.title, "fly");
        drawFace(ctx, fl.actor, r.x - 4, r.y + 1, 0.85, style);
        const cap = captions.get(fl);
        if (cap) {
          const q = cap.rect;
          roundRect(ctx, q.x, q.y, q.w, q.h, 6);
          ctx.fillStyle = C.ground;
          ctx.fill();
          ctx.strokeStyle = C.line;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.font = fontOf(style, 11, 500);
          ctx.fillStyle = C.text2;
          ctx.textAlign = "center";
          ctx.textBaseline = "alphabetic";
          fillText(ctx, cap.text, q.x + q.w / 2, q.y + 14);
        }
        env.hit.rect(r, { kind: "note", workspaceId: fl.to.workspaceId, path: fl.to.path }, LAYER.card);
      } else {
        const R = Math.max(dotRadius(s, fl.to.deg), 2.6) + 0.8;
        circle(ctx, p.x, p.y, R);
        ctx.fillStyle = C.dot;
        ctx.fill();
      }
    } else if (fl.cross) {
      // Landed: a ring spreads from where it came to rest.
      const k = fl.landedFor / 1.6;
      if (k < 1) {
        const R = Math.max(dotRadius(s, fl.to.deg), 2);
        const e = 1 - (1 - k) * (1 - k);
        circle(ctx, p.x, p.y, R + 3 + e * 18);
        ctx.strokeStyle = C.ink;
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
      }
    }
  }
}
