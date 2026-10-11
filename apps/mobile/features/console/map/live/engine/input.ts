/**
 * Pointer input for the map canvas: drag to pan, wheel or pinch to zoom,
 * tap, double-tap and hover. Turns raw pointer events into a few intents and
 * knows nothing about what is drawn.
 */

export type Gestures = {
  /** Pan by a screen delta. */
  pan(dx: number, dy: number): void;
  /** Zoom by `factor` about a screen point. */
  zoom(factor: number, x: number, y: number): void;
  tap(x: number, y: number): void;
  doubleTap(x: number, y: number): void;
  hover(x: number, y: number): void;
  leave(): void;
  /** A gesture began: stop any camera animation. */
  grab(): void;
};

const TAP_SLOP = 6;
const DOUBLE_MS = 320;

export function attachInput(el: HTMLElement, g: Gestures): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let downAt: { x: number; y: number; t: number } | null = null;
  let moved = false;
  let lastTap: { x: number; y: number; t: number } | null = null;
  let pinch: { d: number; mx: number; my: number } | null = null;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), mx: (a!.x + b!.x) / 2, my: (a!.y + b!.y) / 2 };
  };

  const onDown = (e: PointerEvent) => {
    const p = local(e);
    pointers.set(e.pointerId, p);
    el.setPointerCapture?.(e.pointerId);
    g.grab();
    if (pointers.size === 1) {
      downAt = { ...p, t: e.timeStamp };
      moved = false;
    } else if (pointers.size === 2) {
      pinch = pinchState();
      moved = true;
    }
  };
  const onMove = (e: PointerEvent) => {
    const p = local(e);
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === "mouse") g.hover(p.x, p.y);
      return;
    }
    pointers.set(e.pointerId, p);
    if (pointers.size >= 2 && pinch) {
      const next = pinchState();
      if (pinch.d > 0) g.zoom(next.d / pinch.d, next.mx, next.my);
      g.pan(next.mx - pinch.mx, next.my - pinch.my);
      pinch = next;
      return;
    }
    if (downAt && !moved && Math.hypot(p.x - downAt.x, p.y - downAt.y) > TAP_SLOP) moved = true;
    if (moved) g.pan(p.x - prev.x, p.y - prev.y);
  };
  const onUp = (e: PointerEvent) => {
    const p = local(e);
    const had = pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!had || pointers.size > 0) return;
    if (downAt && !moved) {
      if (lastTap && e.timeStamp - lastTap.t < DOUBLE_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24) {
        lastTap = null;
        g.doubleTap(p.x, p.y);
      } else {
        lastTap = { ...p, t: e.timeStamp };
        g.tap(p.x, p.y);
      }
    }
    downAt = null;
  };
  const onCancel = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    downAt = null;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    g.grab();
    // A trackpad pinch arrives as a wheel with ctrlKey and small deltas.
    const k = e.ctrlKey ? 0.012 : 0.0018;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    g.zoom(Math.exp(-dy * k), p.x, p.y);
  };
  const onLeave = () => g.leave();

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("wheel", onWheel, { passive: false });
  const style = el.style as CSSStyleDeclaration & { touchAction?: string };
  const before = style.touchAction;
  style.touchAction = "none";
  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
    el.removeEventListener("pointerleave", onLeave);
    el.removeEventListener("wheel", onWheel);
    style.touchAction = before ?? "";
  };
}
