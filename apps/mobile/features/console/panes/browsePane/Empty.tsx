import { View } from "react-native";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { makeStyles } from "./styles";

/**
 * Nothing open.
 *
 * Says how to open something rather than just that nothing is — and names the
 * gesture that is new, because a right-click menu nobody discovers is a feature
 * that does not exist.
 */
export function Empty({ contextLabel }: { contextLabel: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.empty}>
      <Text variant="paneTitle" role="heading" aria-level={2}>
        {contextLabel}
      </Text>
      <Text variant="paneSub" style={styles.emptyLine}>
        Choose a note to read or edit it. Right-click any row — or press and hold on a phone —
        for everything you can do to it.
      </Text>
    </View>
  );
}
