import type { Icon } from "./chaosStory";

/**
 * The small things page a's graph draws on its canvas (`chaosDraw.ts`): what a
 * note is while it is loose (an email, a text, a calendar invite, a meeting,
 * a chat, a doc), the card a named note shows while a helper reads it, and a
 * faint line.
 */

export type Ink = {
  paper: string;
  ink: string;
  ink2: string;
  hair: string;
  card: string;
  blue: string;
  agents: readonly string[];
};

export const SANS = "ui-sans-serif, system-ui, -apple-system, sans-serif";
/** Small caps, spaced with hair spaces since a canvas has no letter-spacing everywhere. */
export const caps = (s: string) => s.toUpperCase().split("").join(String.fromCharCode(8202));

export function line(ctx: CanvasRenderingContext2D, a: readonly number[], b: readonly number[], alpha: number, color: string, width: number) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a[0]!, a[1]!);
  ctx.lineTo(b[0]!, b[1]!);
  ctx.stroke();
  ctx.restore();
}

/** A card over (x, y): what kind of note it is in small caps, and its title. Kept inside the canvas's width. */
export function pill(ctx: CanvasRenderingContext2D, W: number, x: number, y: number, kind: string, label: string, c: Ink) {
  ctx.font = `500 13px ${SANS}`;
  const w = Math.max(ctx.measureText(label).width, 40) + 18;
  const h = 36;
  const px = Math.min(Math.max(x - w / 2, 2), W - w - 2);
  let py = y - h - 12;
  if (py < 2) py = y + 12;
  ctx.fillStyle = c.card;
  ctx.strokeStyle = c.hair;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(px, py, w, h, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = c.ink2;
  ctx.font = `600 9px ${SANS}`;
  ctx.fillText(caps(kind), px + 9, py + 14);
  ctx.fillStyle = c.ink;
  ctx.font = `500 13px ${SANS}`;
  ctx.fillText(label, px + 9, py + 29);
}

/** A line icon about 14px across, centred on (x, y). `t` lets a meeting pulse and a chat type. */
export function icon(ctx: CanvasRenderingContext2D, kind: Icon, x: number, y: number, t: number, c: Ink) {
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = c.ink2;
  ctx.fillStyle = c.card;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const box = (w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, r);
    ctx.fill();
    ctx.stroke();
  };
  if (kind === "email") {
    box(15, 11, 1.5);
    ctx.beginPath();
    ctx.moveTo(x - 7, y - 4.5);
    ctx.lineTo(x, y + 0.5);
    ctx.lineTo(x + 7, y - 4.5);
    ctx.stroke();
  } else if (kind === "calendar") {
    box(14, 13, 2);
    ctx.beginPath();
    ctx.moveTo(x - 7, y - 2.5);
    ctx.lineTo(x + 7, y - 2.5);
    ctx.moveTo(x - 3.5, y - 8.5);
    ctx.lineTo(x - 3.5, y - 5);
    ctx.moveTo(x + 3.5, y - 8.5);
    ctx.lineTo(x + 3.5, y - 5);
    ctx.stroke();
    ctx.fillStyle = c.blue;
    ctx.fillRect(x + 1, y + 0.5, 3.5, 3.5);
  } else if (kind === "text") {
    // A blue bubble, like a message on a phone.
    ctx.fillStyle = c.blue;
    ctx.beginPath();
    ctx.roundRect(x - 7.5, y - 5.5, 15, 10, 5);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 3, y + 3);
    ctx.lineTo(x + 7.5, y + 7);
    ctx.lineTo(x + 6.5, y + 1);
    ctx.fill();
  } else if (kind === "chat") {
    // A bubble with someone typing in it.
    ctx.beginPath();
    ctx.roundRect(x - 8, y - 6, 16, 11, 4);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 5, y + 5);
    ctx.lineTo(x - 6, y + 8.5);
    ctx.lineTo(x - 1.5, y + 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = c.ink2;
    for (let i = 0; i < 3; i++) {
      const b = Math.sin(t / 160 - i * 0.9) > 0.3 ? 1 : 0;
      ctx.beginPath();
      ctx.arc(x - 4 + i * 4, y - 0.5 - b, 1.1, 0, 7);
      ctx.fill();
    }
  } else if (kind === "meeting") {
    // Two people side by side, and a ring that pulses while they talk.
    const q = (t / 1400) % 1;
    ctx.save();
    ctx.globalAlpha *= (1 - q) * 0.6;
    ctx.beginPath();
    ctx.arc(x, y, 8 + q * 7, 0, 7);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = c.ink2;
    for (const [dx, dy] of [
      [-3.5, 1],
      [3.5, -1],
    ] as const) {
      ctx.beginPath();
      ctx.arc(x + dx, y - 3 + dy, 2.6, 0, 7);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + dx, y + 6 + dy, 4.4, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    // A doc: a page with a folded corner and three lines.
    ctx.beginPath();
    ctx.moveTo(x - 5.5, y - 7);
    ctx.lineTo(x + 2.5, y - 7);
    ctx.lineTo(x + 5.5, y - 4);
    ctx.lineTo(x + 5.5, y + 7);
    ctx.lineTo(x - 5.5, y + 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      ctx.moveTo(x - 3, y - 2 + i * 3);
      ctx.lineTo(x + 3, y - 2 + i * 3);
    }
    ctx.stroke();
  }
}

/** A helper's cursor: an arrow pointer in its colour, with a name flag saying what it is doing. */
export function cursor(ctx: CanvasRenderingContext2D, W: number, hx: number, hy: number, name: string, doing: string, color: string, c: Ink) {
  ctx.save();
  ctx.textAlign = "left";
  ctx.font = `600 11px ${SANS}`;
  const nameW = ctx.measureText(name).width;
  ctx.font = `400 11px ${SANS}`;
  const doW = doing ? ctx.measureText(" · " + doing).width : 0;
  ctx.fillStyle = color;
  ctx.strokeStyle = c.card;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx, hy + 15);
  ctx.lineTo(hx + 4, hy + 11);
  ctx.lineTo(hx + 7, hy + 17);
  ctx.lineTo(hx + 9.5, hy + 16);
  ctx.lineTo(hx + 6.5, hy + 10);
  ctx.lineTo(hx + 11.5, hy + 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  const w = nameW + doW + 14;
  let x = hx + 10;
  const y = hy + 17;
  if (x + w > W - 2) x = W - 2 - w;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 19, 4);
  ctx.fill();
  ctx.fillStyle = c.card;
  ctx.font = `600 11px ${SANS}`;
  ctx.fillText(name, x + 7, y + 13);
  if (doing) {
    ctx.font = `400 11px ${SANS}`;
    ctx.fillText(" · " + doing, x + 7 + nameW, y + 13);
  }
  ctx.restore();
}
