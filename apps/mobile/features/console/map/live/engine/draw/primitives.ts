import type { MapPalette } from "../palette";

/**
 * The map's small drawn pieces: faces and robots, name flags, halo text and
 * note cards. Each takes the context and a palette and draws in screen pixels.
 */

export type Ctx = CanvasRenderingContext2D;

export type Who = { id: string; kind: "person" | "agent"; name: string };

/** A person's picture, or null to draw the silhouette. Agents are always the robot. */
export type FaceFor = (who: Who) => CanvasImageSource | null;

export type Style = {
  palette: MapPalette;
  font: string;
  faceFor: FaceFor | null;
};

export const DEFAULT_FONT = '"Instrument Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

export const fontOf = (style: Style, size: number, weight = 500): string => `${weight} ${size}px ${style.font}`;

/** The radius a face is drawn at, before scaling. */
export const FACE_R = 13;

export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function circle(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
}

/**
 * A face (person) or a robot (agent), centred on (x, y). People are a round
 * picture with a ground-coloured ring; agents are an ink tile with the robot
 * the app's `robot` icon draws, so the two are told apart at a glance.
 */
export function drawFace(ctx: Ctx, who: Who, x: number, y: number, scale: number, style: Style): void {
  const C = style.palette;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.shadowColor = C.shadow;
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  if (who.kind === "person") {
    circle(ctx, 0, 0, FACE_R);
    ctx.fillStyle = C.faceGround;
    ctx.fill();
    ctx.shadowColor = "transparent";
    const img = style.faceFor ? style.faceFor(who) : null;
    ctx.save();
    circle(ctx, 0, 0, FACE_R);
    ctx.clip();
    if (img) ctx.drawImage(img, -FACE_R, -FACE_R, FACE_R * 2, FACE_R * 2);
    else silhouette(ctx, C);
    ctx.restore();
    circle(ctx, 0, 0, FACE_R);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = C.ground;
    ctx.stroke();
  } else {
    roundRect(ctx, -FACE_R, -FACE_R, FACE_R * 2, FACE_R * 2, 7);
    ctx.fillStyle = C.ink;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = C.ground;
    ctx.stroke();
    robot(ctx, C.ground);
  }
  ctx.restore();
}

/** Head and shoulders, for a person with no picture yet. */
function silhouette(ctx: Ctx, C: MapPalette): void {
  ctx.fillStyle = C.faceFigure;
  circle(ctx, 0, -3, 4.6);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, 10.5, 9, 7.5, 0, Math.PI, 0);
  ctx.fill();
}

/** The robot of `faceDom.robotNode`, scaled into a 26px tile: head, antenna, eyes, ears. */
function robot(ctx: Ctx, color: string): void {
  ctx.save();
  ctx.scale(0.72, 0.72);
  ctx.translate(-12, -12.5);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  roundRect(ctx, 4.5, 8, 15, 12, 3.3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(12, 4.6);
  ctx.lineTo(12, 8);
  ctx.moveTo(2.4, 12.3);
  ctx.lineTo(2.4, 16);
  ctx.moveTo(21.6, 12.3);
  ctx.lineTo(21.6, 16);
  ctx.stroke();
  circle(ctx, 12, 3.4, 1.4);
  ctx.fill();
  circle(ctx, 9.2, 13.9, 1.7);
  ctx.fill();
  circle(ctx, 14.8, 13.9, 1.7);
  ctx.fill();
  ctx.restore();
}

/** Three teal dots bouncing under a face: somebody is typing. */
export function typingDots(ctx: Ctx, x: number, y: number, phase: number, style: Style, still: boolean): void {
  ctx.fillStyle = style.palette.accent;
  for (let i = 0; i < 3; i += 1) {
    const b = still ? 0 : Math.max(0, Math.sin(phase * 8 - i * 0.8));
    circle(ctx, x - 6 + i * 6, y - b * 3, 1.9);
    ctx.fill();
  }
}

export type FlagSize = { w: number; h: number };

export function flagSize(ctx: Ctx, style: Style, text: string, sub: string | null): FlagSize {
  ctx.font = fontOf(style, 12, 600);
  const w = ctx.measureText(text).width;
  let w2 = 0;
  if (sub) {
    ctx.font = fontOf(style, 10.5, 500);
    w2 = ctx.measureText(sub).width;
  }
  return { w: Math.max(w, w2) + 16, h: sub ? 34 : 22 };
}

/** A name tag: the name, and under it what they are doing. */
export function drawFlag(ctx: Ctx, style: Style, x: number, y: number, text: string, sub: string | null): void {
  const C = style.palette;
  const { w, h } = flagSize(ctx, style, text, sub);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.12)";
  ctx.shadowBlur = 6;
  roundRect(ctx, x, y, w, h, 7);
  ctx.fillStyle = C.ground;
  ctx.fill();
  ctx.restore();
  roundRect(ctx, x, y, w, h, 7);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.text;
  ctx.font = fontOf(style, 12, 600);
  ctx.fillText(text, x + 8, y + 15);
  if (sub) {
    ctx.fillStyle = C.dim;
    ctx.font = fontOf(style, 10.5, 500);
    ctx.fillText(sub, x + 8, y + 28);
  }
}

/** Text with a halo in the bubble colour, so it stays legible over links and dots. */
export function haloText(
  ctx: Ctx,
  style: Style,
  text: string,
  x: number,
  y: number,
  size: number,
  weight: number,
  color: string,
  halo: string = style.palette.zone,
): void {
  ctx.font = fontOf(style, size, weight);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** The small page icon cards and chips carry. */
export function docIcon(ctx: Ctx, x: number, y: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 6, y);
  ctx.lineTo(x + 9, y + 3);
  ctx.lineTo(x + 9, y + 13);
  ctx.lineTo(x, y + 13);
  ctx.closePath();
  ctx.stroke();
}

/** Shorten `text` with an ellipsis until it fits `max` pixels in the current font. */
export function fitText(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** A note as a card (folders view, and a note in flight between workspaces). */
export function drawCard(
  ctx: Ctx,
  style: Style,
  x: number,
  y: number,
  w: number,
  title: string,
  state: "new" | "fly" | null,
): void {
  const C = style.palette;
  roundRect(ctx, x, y, w, 32, 8);
  ctx.fillStyle = C.ground;
  ctx.fill();
  ctx.strokeStyle = state === "new" ? C.accent : state === "fly" ? C.ink : C.line;
  ctx.lineWidth = state ? 1.5 : 1;
  ctx.stroke();
  ctx.lineWidth = 1;
  docIcon(ctx, x + 12, y + 10, C.dim);
  ctx.fillStyle = C.text;
  ctx.font = fontOf(style, 13, 500);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(fitText(ctx, title, w - (state === "new" ? 76 : 44)), x + 30, y + 20.5);
  if (state === "new") {
    ctx.fillStyle = C.accent;
    ctx.font = fontOf(style, 10, 700);
    ctx.textAlign = "right";
    ctx.fillText("NEW", x + w - 10, y + 20);
  }
}
