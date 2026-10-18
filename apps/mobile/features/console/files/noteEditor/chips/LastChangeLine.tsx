import { Pressable, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { space } from "../../../../design/tokens";
import { useColors } from "../../../../design/theme";

/**
 * "Claude changed this at 9:31 · See activity", under the note's name, when
 * somebody other than the reader's own hand changed it last (board 3, option
 * A; `activity/lastChange.ts`). Plain text, no box: it is a fact about the
 * note, said once, and the activity list is where the rest is. A long name
 * gives way before the link does.
 */
export function LastChangeLine({ text, onOpen }: { text: string; onOpen?: () => void }) {
  const colors = useColors();
  const line = (
    <View style={{ flexDirection: "row", maxWidth: "100%" }}>
      <Text variant="meta" numberOfLines={1} style={{ color: colors.muted, flexShrink: 1 }} testID="note-last-change">
        {text}
      </Text>
      {onOpen === undefined ? null : (
        <Text variant="meta" numberOfLines={1} style={{ color: colors.accentText, flexShrink: 0 }}>
          {"\u00a0· See activity"}
        </Text>
      )}
    </View>
  );
  if (onOpen === undefined) return <View style={{ paddingBottom: space.x1 }}>{line}</View>;
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="link"
      accessibilityLabel={`${text}. See activity`}
      style={{ alignSelf: "flex-start", maxWidth: "100%", paddingBottom: space.x1 }}
    >
      {line}
    </Pressable>
  );
}
