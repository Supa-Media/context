/**
 * The file tree folds away while the side panel is on screen, and comes back
 * when it goes — only if it was showing when the panel came.
 *
 * Notion's side peek, as the owner asked for it (2026-09-28): the panel wants
 * the width, and the tree is the one thing on the screen that can give it
 * without hiding what was pressed. Remembered here, for as long as the panel
 * is open, and nowhere else: somebody who had the tree folded keeps it
 * folded, and somebody who brings it back while the panel is open keeps it.
 *
 * The frame's own field, set through `setExplorerFolded` rather than flipped,
 * so a second run of this effect (React's development double effects) folds
 * nothing twice. Called by the panel itself, so it holds exactly while the
 * panel is drawn: moving from row to row keeps it, and closing it, switching
 * to Notes, or leaving the page — Expand, another folder — brings the tree
 * back the same way.
 */

import { useEffect, useRef } from "react";
import { useFrame } from "../../../../app/appFrame/context";

export function useFoldTree(): void {
  const frame = useFrame();
  // Read when the panel opens and closes, not a reason to run again.
  const latest = useRef(frame);
  latest.current = frame;
  useEffect(() => {
    const shown = latest.current.regions.explorer === "column";
    if (shown) latest.current.setExplorerFolded(true);
    return () => {
      if (shown) latest.current.setExplorerFolded(false);
    };
  }, []);
}
