/**
 * Which row is open in a project page's side panel, and whether the page
 * has room for one.
 *
 * Per page and per viewer, held only while the page is open: nothing is
 * written, and moving to another folder closes it. On a phone, or a page too
 * narrow for the panel itself (`panelFits`), there is no panel and pressing a
 * row opens its page as it always has. Escape closes it — unless a menu or a
 * field has the key, which answer it first.
 */

import { useCallback, useEffect, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";
import { panelFits } from "./panelModel";

export interface TaskPanelState {
  /** The row shown, or null when the panel is closed or has no room. */
  readonly path: string | null;
  /** Whether a pressed row opens here rather than on its own page. */
  readonly fits: boolean;
  show(path: string): void;
  close(): void;
}

export function useTaskPanel(folder: string, compact: boolean, pageWidth: number): TaskPanelState {
  const { width } = useWindowDimensions();
  const fits = !compact && panelFits(pageWidth, width);
  const [open, setOpen] = useState<{ folder: string; path: string } | null>(null);
  const path = fits && open !== null && open.folder === folder ? open.path : null;
  const show = useCallback((next: string) => setOpen({ folder, path: next }), [folder]);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    if (path === null || Platform.OS !== "web" || typeof document === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active !== null && /^(input|textarea|select)$/i.test(active.tagName)) return;
      if ((active as HTMLElement | null)?.isContentEditable === true) return;
      if (document.querySelector('[role="menu"], [role="dialog"], [aria-modal="true"]') !== null) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [path, close]);

  return { path, fits, show, close };
}
