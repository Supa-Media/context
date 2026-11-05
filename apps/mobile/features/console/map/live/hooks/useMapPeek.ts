import { useCallback, useEffect, useRef, useState } from "react";
import type { CameraDetail, MapEngine } from "../engine";
import { mapMemoryKey, recallMap, rememberCamera, rememberPeek } from "../peek/mapMemory";
import type { OpenPeek } from "../ui/NotePeek";
import type { MapPageState } from "./useMapPage";

export type MapPeek = {
  /** The note the card is open on, or `null`. */
  peek: OpenPeek | null;
  close: () => void;
  /** Show this note: Find, and a link in the preview. */
  show: (note: OpenPeek) => void;
  /**
   * A click on a note on the map selects it; a click on the selected note
   * unselects it. A click on empty space does nothing: it is how people look
   * around (Dev2, 2026-11-05), so the chip's ×, Esc and a second click are
   * the ways to unselect.
   */
  onTapNote: (note: OpenPeek) => void;
  /** Kept as you move, so the map comes back where you left it. */
  onCamera: (detail: CameraDetail) => void;
  /** The engine arriving: put the camera and the highlighted note back. */
  onEngine: (engine: MapEngine | null) => void;
};

/**
 * The map's card and its memory. A dot tap opens the card on that note and
 * highlights the dot; the camera is remembered as it moves, and the card as
 * it opens and closes, per workspace and scope (`peek/mapMemory.ts`). So when
 * Expand leaves the map for the note and Back brings the map again, the
 * engine is handed the same camera and the card opens on the same note.
 */
export function useMapPeek(page: MapPageState): MapPeek {
  const key = mapMemoryKey(page.selected?.id ?? null, page.scope);
  const recalled = (k: string): OpenPeek | null => {
    const kept = recallMap(k).peek;
    return kept === null ? null : { ...kept, at: null };
  };
  const [state, setState] = useState<{ key: string; peek: OpenPeek | null }>(() => ({ key, peek: recalled(key) }));
  // Another workspace or scope remembers its own card.
  const peek = state.key === key ? state.peek : recalled(key);
  const peekRef = useRef(peek);
  peekRef.current = peek;
  const keyRef = useRef(key);
  keyRef.current = key;
  const engineRef = page.engineRef;

  const open = useCallback(
    (next: OpenPeek | null) => {
      setState({ key: keyRef.current, peek: next });
      rememberPeek(keyRef.current, next === null ? null : { workspaceId: next.workspaceId, path: next.path });
      engineRef.current?.select(next === null ? null : { workspaceId: next.workspaceId, path: next.path });
    },
    [engineRef],
  );

  useEffect(() => {
    // The card for this scope, highlighted, once the scope changes under it.
    const kept = recallMap(key).peek;
    engineRef.current?.select(kept);
  }, [key, engineRef]);

  const onCamera = useCallback((detail: CameraDetail) => rememberCamera(keyRef.current, detail.cam), []);
  const onEngine = useCallback((engine: MapEngine | null) => {
    if (engine === null) return;
    const { cam } = recallMap(keyRef.current);
    if (cam !== null) engine.restoreCamera(cam);
    const shown = peekRef.current;
    if (shown !== null) engine.select({ workspaceId: shown.workspaceId, path: shown.path });
  }, []);

  const close = useCallback(() => open(null), [open]);
  // Esc unselects, wherever the focus is, while a note is selected (web).
  const selected = peek !== null;
  useEffect(() => {
    if (!selected || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, close]);

  return {
    peek,
    close,
    show: open,
    onTapNote: useCallback(
      (note: OpenPeek) => {
        const shown = peekRef.current;
        open(shown !== null && shown.workspaceId === note.workspaceId && shown.path === note.path ? null : note);
      },
      [open],
    ),
    onCamera,
    onEngine,
  };
}
