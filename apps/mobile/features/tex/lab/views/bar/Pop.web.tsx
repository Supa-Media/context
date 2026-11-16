/**
 * One small menu under a button, for the decluttered top bar and test chat (mockup
 * https://claude.ai/artifact/W21NekNf2vtnFLXXzAmp7N, approved by Dev2 2026-11-16): opens on click, closes on a click
 * outside or Escape, and only one is open at a time.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

let closeOpen: (() => void) | null = null;

export function Pop({
  id,
  label,
  button,
  className = "chipbtn",
  title,
  right = false,
  children,
}: {
  id: string;
  label?: string;
  button: ReactNode;
  className?: string;
  title?: string;
  right?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<React.CSSProperties>({});
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  // Fixed to the viewport, so a menu inside a scrolled grid (the test chat's ⋯) isn't clipped; it opens upward near
  // the bottom of the window (the test chat is docked there).
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom + 320 > window.innerHeight && r.top > window.innerHeight / 2;
    setAt({
      position: "fixed",
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      ...(right ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) }),
    });
  };
  const close = () => setOpen(false);
  useEffect(() => {
    if (!open) return;
    closeOpen?.();
    closeOpen = close;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Fixed in place, so a scroll under it (not inside it) or a resize closes it.
    const moved = (e: Event) => {
      if (!(e.target instanceof Node) || !box.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    document.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      if (closeOpen === close) closeOpen = null;
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
      document.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <span className="popw" ref={box}>
      <button
        type="button"
        ref={btn}
        className={className}
        id={id}
        aria-label={label}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) place();
          setOpen(!open);
        }}
      >
        {button}
      </button>
      {open ? (
        <div className={"popm" + (right ? " right" : "")} role="menu" id={id + "Menu"} style={at} onClick={(e) => e.stopPropagation()}>
          {children(close)}
        </div>
      ) : null}
    </span>
  );
}
