import { useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { autoFitItemWidth } from "../grid";

/**
 * `repeat(auto-fit, minmax(minItemWidth, 1fr))` for React Native.
 *
 * Measures itself, works out what CSS Grid would have done, and gives every
 * child that exact width — including the last one on a short final row, which
 * is the case plain `flexWrap` gets wrong. See `grid.ts`.
 */
export function AutoGrid<T>({
  items,
  minItemWidth,
  gap,
  renderItem,
  keyExtractor,
  style,
}: {
  items: readonly T[];
  minItemWidth: number;
  gap: number;
  renderItem: (item: T, index: number) => ReactNode;
  keyExtractor: (item: T, index: number) => string;
  style?: ViewStyle;
}) {
  const [width, setWidth] = useState(0);

  const onLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    if (next !== width) setWidth(next);
  };

  const itemWidth = autoFitItemWidth(width, minItemWidth, gap);

  return (
    <View style={[styles.grid, { gap }, style]} onLayout={onLayout}>
      {items.map((item, index) => (
        <View
          key={keyExtractor(item, index)}
          // Before the first layout pass there is no width to divide up; fall
          // back to one full-width column rather than rendering zero-width.
          style={itemWidth > 0 ? { width: itemWidth } : styles.unmeasured}
        >
          {renderItem(item, index)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  unmeasured: { width: "100%" },
});
