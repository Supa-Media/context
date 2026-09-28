/**
 * A project page's List or Board with the task side panel at its right.
 *
 * Always the same two views, open or not, so opening the panel never
 * redraws the list under it (a folded band stays as it was). Open, the
 * page's contents widen past the note's measure the way a Board does: into
 * the room at the right first, so the list stays where it was under the
 * title, and only then to the left.
 */

import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { noteColumnWidth } from "../../../../app/frame";
import { PANEL_GAP, PANEL_WIDTH } from "./panelModel";

/** What a page leaves either side of what it draws, as the Board does. */
const PAGE_MARGIN = 48;

export function PanelBeside({
  panel,
  pageWidth,
  wide,
  style,
  children,
}: {
  panel: ReactNode | null;
  /** The page's own width; 0 before it is measured. */
  pageWidth: number;
  /** A Board, which takes the whole page beside the panel rather than keeping the note's measure. */
  wide: boolean;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const open = panel !== null;
  return (
    <View style={[style, open && styles.row, open && reach(pageWidth, wide)]}>
      <View style={open ? styles.main : undefined}>{children}</View>
      {panel}
    </View>
  );
}

function reach(pageWidth: number, wide: boolean): ViewStyle | undefined {
  if (pageWidth <= 0) return undefined;
  const side = Math.max(0, (pageWidth - noteColumnWidth) / 2 - PAGE_MARGIN);
  const need = PANEL_WIDTH + PANEL_GAP;
  const right = Math.min(side, need);
  const left = wide ? side : Math.min(side, need - right);
  return { width: noteColumnWidth + left + right, marginLeft: -left };
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: PANEL_GAP },
  main: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
});
