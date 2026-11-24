/**
 * The choices themselves and their look, shared by the phone's menu
 * (`SuggestionMenu.tsx`) and the browser's (`SuggestionMenu.web.tsx`). Its own
 * file because a `.web` module importing `./SuggestionMenu` imports itself.
 */

import type { RefObject } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";

export interface SuggestionMenuProps {
  /** The field the menu hangs from. */
  anchor: RefObject<View | null>;
  suggestions: readonly string[];
  /** The choice Enter would take, or -1 for what is typed. */
  highlight: number;
  onPick: (value: string) => void;
}

export function SuggestionList({ suggestions, highlight, onPick }: Omit<SuggestionMenuProps, "anchor">) {
  const styles = useThemedStyles(makeSuggestionStyles);
  return (
    <>
      {suggestions.map((s, i) => (
        <Pressable
          key={s}
          accessibilityRole="button"
          accessibilityState={{ selected: i === highlight }}
          onPress={() => onPick(s)}
          style={(state) => [styles.option, (i === highlight || (state as { hovered?: boolean }).hovered) && styles.optionOn]}
        >
          <Text variant="body" numberOfLines={1} style={styles.optionText}>
            {s}
          </Text>
        </Pressable>
      ))}
    </>
  );
}

export const makeSuggestionStyles = (colors: Colors) =>
  StyleSheet.create({
    menu: {
      minWidth: 180,
      maxHeight: 248,
      padding: space.x1,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
      overflow: "hidden",
    },
    floating: { boxShadow: "0 24px 60px -18px rgba(0,0,0,.9)" } as object,
    inline: { position: "absolute", top: 30, left: 0, zIndex: 10 },
    option: { height: 28, justifyContent: "center", paddingHorizontal: space.x2, borderRadius: radii.sm },
    optionOn: { backgroundColor: colors.surface2 },
    optionText: { color: colors.text },
  });
