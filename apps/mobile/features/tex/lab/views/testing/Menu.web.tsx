/**
 * The Testing tab's ⋯ menus (Dev2, 2026-11-16, the simplified Testing page): a small list under the button that
 * opened it, closed by a pick, a click elsewhere or Escape.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem = { label: string; key?: string; check?: boolean; bad?: boolean; disabled?: boolean; keepOpen?: boolean; run: () => void } | "hr" | { head: string } | { node: React.ReactNode };

export function useMenu() {
  const [at, setAt] = useState<{ el: HTMLElement; id: string } | null>(null);
  return {
    openId: at?.id ?? null,
    anchor: at?.el ?? null,
    toggle: (e: React.MouseEvent<HTMLElement>, id: string) => {
      e.stopPropagation();
      const el = e.currentTarget;
      setAt((cur) => (cur?.id === id ? null : { el, id }));
    },
    close: () => setAt(null),
  };
}

export function Menu({ anchor, items, onClose, id }: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void; id?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = ref.current?.offsetWidth ?? 220;
    const h = ref.current?.offsetHeight ?? 0;
    const top = r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4;
    setPos({ top, left: Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) });
  }, [anchor, items.length]);
  useEffect(() => {
    const out = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", out);
      document.removeEventListener("keydown", esc, true);
    };
  }, [anchor, onClose]);
  return (
    <div className="ts-menu" role="menu" id={id} ref={ref} style={pos} onClick={(e) => e.stopPropagation()}>
      {items.map((it, k) => {
        if (it === "hr") return <hr key={k} />;
        if ("head" in it)
          return (
            <div key={k} className="h">
              {it.head}
            </div>
          );
        if ("node" in it) return <div key={k}>{it.node}</div>;
        return (
          <button
            key={k}
            role="menuitem"
            className={"it" + (it.bad ? " bad" : "")}
            disabled={it.disabled}
            onClick={() => {
              it.run();
              if (!it.keepOpen) onClose();
            }}
          >
            {it.check !== undefined ? <span className="ck">{it.check ? "✓" : ""}</span> : null}
            <span>{it.label}</span>
            {it.key ? <span className="k">{it.key}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export const More = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5" cy="12" r="1.3" />
    <circle cx="12" cy="12" r="1.3" />
    <circle cx="19" cy="12" r="1.3" />
  </svg>
);
export const Plus = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const Chev = ({ left }: { left?: boolean }) => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
    <path d={left ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
  </svg>
);
export const Close = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const UndoI = ({ redo }: { redo?: boolean }) => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
    {redo ? (
      <>
        <path d="M15 14l5-5-5-5" />
        <path d="M20 9H10a6 6 0 0 0 0 12h3" />
      </>
    ) : (
      <>
        <path d="M9 14L4 9l5-5" />
        <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
      </>
    )}
  </svg>
);
export const PicI = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M20.5 16l-5-5-8 8" />
  </svg>
);
