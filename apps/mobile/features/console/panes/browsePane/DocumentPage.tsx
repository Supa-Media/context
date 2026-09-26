import type { ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { densityFor, noteColumnWidth } from "../../../app/frame";
import { layout } from "../../../design/tokens";

/**
 * The page a document in the browse region sits on, for a view that does not
 * draw its own.
 *
 * `BrowsePane` runs the phone's scroll surface full-bleed so a note can keep
 * its own reading margin, which means every other document has to supply one.
 * On a pointer layout the pane pads itself, and the document is centred in the
 * note's measure instead. `FolderView` does both itself (its outer view is also
 * the right-click target, so it keeps its own structure) and takes the two
 * styles below from here, so the margin a folder listing gets and the margin a
 * page wrapped in this gets are one value rather than two that can drift.
 *
 * The communications pages (Inbox, a channel, a channel's day, a contact)
 * were mounted bare, with neither, and sat on the edge of the glass.
 */
export const documentMargin = StyleSheet.create({
  /** The reading margin, on the density where nothing else supplies one. */
  compact: { paddingHorizontal: layout.readingMargin },
  /** The note's measure, centred in what is left. Inert on a phone. */
  column: { width: "100%", maxWidth: noteColumnWidth, alignSelf: "center" },
});

export function DocumentPage({ children }: { children: ReactNode }) {
  const compact = densityFor(useWindowDimensions().width) === "compact";
  return (
    <View style={compact ? documentMargin.compact : undefined} testID="document-page">
      <View style={documentMargin.column} testID="document-column">
        {children}
      </View>
    </View>
  );
}
