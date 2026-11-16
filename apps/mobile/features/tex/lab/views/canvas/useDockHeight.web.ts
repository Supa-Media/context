/**
 * The test chat dock's height, set by dragging the grip on its top edge (Lab live sandbox mockup, Dev2 2026-11-16):
 * between 120px and the canvas's space less 120px, remembered in this browser.
 */
import { useRef, useState, type PointerEvent as RPointerEvent } from "react";

const KEY = "texLab.dockH";
export const DOCK_MIN = 120;

function saved(): number | null {
  try {
    const h = Number(localStorage.getItem(KEY));
    return Number.isFinite(h) && h >= DOCK_MIN ? h : null;
  } catch {
    return null;
  }
}

/** The height (null: the stylesheet's), whether it is being dragged, and the grip's pointer handlers. */
export function useDockHeight() {
  const [h, setH] = useState<number | null>(saved);
  const [drag, setDrag] = useState(false);
  const cur = useRef<number | null>(h);
  const st = useRef<{ y: number; h: number; max: number } | null>(null);
  const grip = {
    onPointerDown(e: RPointerEvent<HTMLElement>) {
      const dock = e.currentTarget.parentElement;
      if (!dock || dock.classList.contains("min")) return;
      const room = dock.parentElement?.getBoundingClientRect().height ?? 0;
      st.current = { y: e.clientY, h: dock.getBoundingClientRect().height, max: Math.max(DOCK_MIN, room - DOCK_MIN) };
      setDrag(true);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove(e: RPointerEvent<HTMLElement>) {
      const s = st.current;
      if (!s) return;
      cur.current = Math.round(Math.max(DOCK_MIN, Math.min(s.max, s.h + s.y - e.clientY)));
      setH(cur.current);
    },
    onPointerUp() {
      if (!st.current) return;
      st.current = null;
      setDrag(false);
      try {
        if (cur.current !== null) localStorage.setItem(KEY, String(cur.current));
      } catch {
        /* a private window: the height lasts until reload */
      }
    },
  };
  return { h, drag, grip: { ...grip, onPointerCancel: grip.onPointerUp } };
}
