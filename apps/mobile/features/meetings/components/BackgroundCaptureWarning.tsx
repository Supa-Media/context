import { StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { layout } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * The sticky "this records only while the app stays open" band on the phone's
 * meeting screen, moved out of `LiveMeetingScreen` unchanged.
 */
export function BackgroundCaptureWarning({ message }: { message: string | null }) {
  const styles = useThemedStyles(makeStyles);
  if (message === null) return null;
  return (
    <View style={styles.band} testID="meeting-background-warning">
      <Text variant="rowSub" style={styles.text}>
        {message}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    band: {
      marginHorizontal: layout.readingMargin,
      marginBottom: 12,
    },
    text: { color: colors.warnText, fontWeight: "600" },
  });
