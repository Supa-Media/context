import { bar, chevron, dot, rect, ring, type DrawFn } from "./primitives";

type RemoteIconName = "keyboard" | "mouse" | "touch" | "backspace" | "enter";

/**
 * The remote screen at `/tex/<handle>`: its top bar's keyboard and input-mode
 * toggle, and the send-text bar's two keys. Drawn with the same primitives as
 * the rest of the set, so a toolbar of them reads as one family.
 */
export const remoteIcons: Record<RemoteIconName, DrawFn> = {
  keyboard: (u, w, c) => [
    /*
      `keyboardHide` without its chevron, centred: summoning a keyboard is the
      bare keyboard, which is exactly what that drawing's comment says it is
      not.
    */
    rect("body", u, w, c, { x0: 0.06, y0: 0.22, x1: 0.94, y1: 0.78, radius: 0.12 }),
    dot("k1", u, c, { cx: 0.28, cy: 0.4, r: 0.05 }),
    dot("k2", u, c, { cx: 0.5, cy: 0.4, r: 0.05 }),
    dot("k3", u, c, { cx: 0.72, cy: 0.4, r: 0.05 }),
    bar("space", u, w, c, { cx: 0.5, cy: 0.6, length: 0.36 }),
  ],

  /** Trackpad mode: a mouse, the thing the finger is standing in for. A scroll wheel, not two buttons, so it reads at 18pt. */
  mouse: (u, w, c) => [
    rect("body", u, w, c, { x0: 0.26, y0: 0.08, x1: 0.74, y1: 0.92, radius: 0.24 }),
    bar("wheel", u, w, c, { cx: 0.5, cy: 0.3, length: 0.14, angle: 90 }),
  ],

  /** Touch mode: a fingertip on the glass and the ripple it leaves. */
  touch: (u, w, c) => [ring("ripple", u, w, c, { cx: 0.5, cy: 0.5, r: 0.36 }), dot("tip", u, c, { cx: 0.5, cy: 0.5, r: 0.13 })],

  /*
    The send-text bar's delete key, as every keyboard draws it: a key with a
    point on its left, and a cross inside. The head is `arrowLeft`'s, so its
    arms end where the body begins.
  */
  backspace: (u, w, c) => [
    chevron("head", u, w, c, { cx: 0.3, cy: 0.5, side: 0.34, angle: -135 }),
    rect("body", u, w, c, { x0: 0.3, y0: 0.26, x1: 0.92, y1: 0.74, radius: 0.08 }),
    bar("x1", u, w, c, { cx: 0.61, cy: 0.5, length: 0.24, angle: 45 }),
    bar("x2", u, w, c, { cx: 0.61, cy: 0.5, length: 0.24, angle: -45 }),
  ],

  /** Return: down the right side and back along the line, `arrowLeft`'s head at the end. */
  enter: (u, w, c) => [
    bar("down", u, w, c, { cx: 0.78, cy: 0.4, length: 0.44, angle: 90 }),
    bar("back", u, w, c, { cx: 0.5, cy: 0.62, length: 0.58 }),
    chevron("head", u, w, c, { cx: 0.34, cy: 0.62, side: 0.34, angle: -135 }),
  ],
};
