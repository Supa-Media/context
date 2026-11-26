/**
 * The right edge of a column's header in the browser: an 8px strip that
 * shows a 3px accent bar under the pointer, drags the column's width, and
 * fits it to its values on a double-click. The width is the grid's to apply
 * and save; this only reports the pointer.
 */

import { useEffect, useRef, useState } from "react";
import type { ResizeEdgeProps } from "./resizeEdgeProps";

export function ResizeEdge({ name, active, color, onStart, onMove, onEnd, onFit, onHover }: ResizeEdgeProps) {
  const [over, setOver] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    onStart();
    const move = (e: PointerEvent) => onMove(e.clientX - startX);
    const up = () => {
      stop.current?.();
      onEnd();
    };
    stop.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      stop.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${name}`}
      data-testid="sheet-resize-edge"
      onPointerDown={down}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onFit();
      }}
      onPointerEnter={() => {
        setOver(true);
        onHover(true);
      }}
      onPointerLeave={() => {
        setOver(false);
        onHover(false);
      }}
      style={{ position: "absolute", top: 0, bottom: 0, right: -4, width: 8, cursor: "col-resize", zIndex: 3, display: "flex", justifyContent: "center" }}
    >
      {over || active ? <div style={{ width: 3, height: "100%", background: color }} /> : null}
    </div>
  );
}
