import { View } from "react-native";
import { PropertyChips } from "./PropertyChips";
import type { ChipsPlacementProps } from "./placement";

/**
 * The chips on native, where the editor is a `WebView` and nothing React can
 * be drawn inside it: a row over the editor, at the note's own margin. That
 * puts them under a name drawn above the editor (`NameField`) and over a
 * `# title` in the body. There is no pointer, so they behave as a thumb's
 * (`touch`).
 */
export function ChipsPlacement({ gutter, ...chips }: ChipsPlacementProps) {
  return (
    <View style={{ paddingHorizontal: gutter, paddingBottom: 8 }}>
      <PropertyChips {...chips} touch revealed={false} />
    </View>
  );
}
