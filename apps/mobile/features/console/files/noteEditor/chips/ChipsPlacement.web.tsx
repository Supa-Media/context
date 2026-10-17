import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LastChangeLine } from "./LastChangeLine";
import { PropertyChips } from "./PropertyChips";
import type { ChipsPlacementProps } from "./placement";

/**
 * The chips on the web: portalled into `host`, which the editor keeps in a box
 * under the note's title (`liveEditorWeb/propertySlot.ts`), so they read as
 * the name's and scroll with it.
 *
 * `revealed` is the pointer over the chips or over the title line right above
 * them — the place somebody looks for "add a status" — read from the page's
 * own `pointerover` rather than from hover handlers on the line, which is
 * CodeMirror's DOM and redrawn under us.
 */
export function ChipsPlacement({ host, compact, lastChange, ...chips }: ChipsPlacementProps) {
  const revealed = useRevealed(host);
  if (host === null) return null;
  return createPortal(
    <>
      {lastChange == null ? null : <LastChangeLine {...lastChange} />}
      <PropertyChips {...chips} touch={compact} revealed={revealed} />
    </>,
    host,
  );
}

function useRevealed(host: HTMLElement | null): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (host === null || typeof document === "undefined") return;
    const over = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null;
      const box = host.parentElement;
      const title = box?.previousElementSibling ?? null;
      setRevealed(target !== null && box !== null && (box.contains(target) || (title !== null && title.contains(target))));
    };
    const away = () => setRevealed(false);
    document.addEventListener("pointerover", over);
    document.documentElement.addEventListener("pointerleave", away);
    return () => {
      document.removeEventListener("pointerover", over);
      document.documentElement.removeEventListener("pointerleave", away);
    };
  }, [host]);
  return revealed;
}
