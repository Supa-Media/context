/**
 * The browser's suggestion menu: drawn into the page's body at the field's
 * place in the window, so neither the row below nor the grid's scrolling list
 * can cover or cut it (Dev, 2026-11-24: an Owner cell's people never showed).
 * It follows the field while it is open, and opens upwards when there is no
 * room below.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ScrollView, View } from "react-native";
import { useThemedStyles } from "../../../design/theme";
import { makeSuggestionStyles, SuggestionList, type SuggestionMenuProps } from "./suggestionList";

const MENU_MAX = 248;

export function SuggestionMenu({ anchor, suggestions, highlight, onPick }: SuggestionMenuProps) {
  const styles = useThemedStyles(makeSuggestionStyles);
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);

  useEffect(() => {
    if (suggestions.length === 0) return;
    let frame = 0;
    const measure = () => {
      const node = anchor.current as unknown as HTMLElement | null;
      if (!node || typeof node.getBoundingClientRect !== "function") return;
      const box = node.getBoundingClientRect();
      const below = window.innerHeight - box.bottom;
      const top = below < MENU_MAX + 8 && box.top > below ? Math.max(8, box.top - MENU_MAX - 4) : box.bottom + 4;
      setAt((old) => (old && old.left === box.left && old.top === top && old.width === box.width ? old : { left: box.left, top, width: box.width }));
    };
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [anchor, suggestions.length]);

  if (suggestions.length === 0 || typeof document === "undefined") return null;
  return createPortal(
    // A press here must not take focus from the field: its blur would commit what is typed before the pick lands.
    <div onMouseDown={(event) => event.preventDefault()}>
    <View
      style={[styles.menu, styles.floating, { position: "fixed" as "absolute", left: at?.left ?? 0, top: at?.top ?? 0, minWidth: Math.max(180, at?.width ?? 0), zIndex: 1000, opacity: at === null ? 0 : 1 }]}
      testID="sheet-cell-suggestions"
    >
      <ScrollView keyboardShouldPersistTaps="always">
        <SuggestionList suggestions={suggestions} highlight={highlight} onPick={onPick} />
      </ScrollView>
    </View>
    </div>,
    document.body,
  );
}
