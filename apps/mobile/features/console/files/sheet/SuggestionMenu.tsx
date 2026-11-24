/**
 * The choices under a select or person cell while it is edited. On a phone
 * they hang under the field inside the row, as they always did; the browser's
 * copy (`SuggestionMenu.web.tsx`) floats above the page instead, because the
 * grid's rows and its scrolling list clip anything drawn inside them.
 */

import { View } from "react-native";
import { useThemedStyles } from "../../../design/theme";
import { makeSuggestionStyles, SuggestionList, type SuggestionMenuProps } from "./suggestionList";

export function SuggestionMenu({ suggestions, highlight, onPick }: SuggestionMenuProps) {
  const styles = useThemedStyles(makeSuggestionStyles);
  if (suggestions.length === 0) return null;
  return (
    <View style={[styles.menu, styles.inline]} testID="sheet-cell-suggestions">
      <SuggestionList suggestions={suggestions} highlight={highlight} onPick={onPick} />
    </View>
  );
}
