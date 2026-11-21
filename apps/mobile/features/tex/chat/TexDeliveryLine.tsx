import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { radii, space, texChatType } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { QUEUED_SENTENCE, TRY_AGAIN, deliveryWord, failedSentence, type DeliveryState } from "./appChatRun";

/**
 * The line under the person's own bubble: when it went, how it is going, and
 * what to do when it did not go.
 *
 * A failed row carries its own sentence and a retry; it has no time line, as
 * in the mock. A queued row says Tex reads it after its current step and keeps
 * the time line under it. Otherwise the time and the delivery word.
 */
export function TexDeliveryLine({
  state,
  at,
  failedAt,
  onRetry,
  testID,
}: {
  state: DeliveryState;
  /** The time the person sent it, as drawn, e.g. "8:25 AM". */
  at: string;
  /** The time the failure happened, when it differs from `at`. */
  failedAt?: string;
  onRetry: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);

  if (state === "failed") {
    return (
      <View style={styles.failedRow} testID={testID}>
        <Text variant="meta" style={styles.failedText}>
          {failedSentence(failedAt ?? at)}
        </Text>
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={TRY_AGAIN}
          style={styles.retry}
          testID={testID === undefined ? undefined : `${testID}-retry`}
        >
          <Text variant="meta" style={styles.retryText}>
            {TRY_AGAIN}
          </Text>
        </Pressable>
      </View>
    );
  }

  const word = deliveryWord(state);
  const meta = [at, word].filter(Boolean).join(" · ");

  return (
    <View style={styles.column} testID={testID}>
      {state === "queued" ? (
        <Text variant="meta" style={styles.queued}>
          {QUEUED_SENTENCE}
        </Text>
      ) : null}
      <Text variant="meta" style={styles.meta}>
        {meta}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    column: { alignSelf: "flex-end", alignItems: "flex-end", gap: 3, marginTop: 3 },
    meta: { color: colors.appDim, fontSize: texChatType.status },
    queued: { color: colors.warnText, fontSize: texChatType.status },
    failedRow: {
      alignSelf: "flex-end",
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      marginTop: space.x1,
      paddingVertical: 5,
      paddingLeft: 10,
      paddingRight: 6,
      borderRadius: radii.card,
      backgroundColor: colors.critWash,
    },
    failedText: { color: colors.critText, fontSize: texChatType.small },
    retry: {
      paddingVertical: 2,
      paddingHorizontal: space.x2,
      borderRadius: radii.md,
      backgroundColor: colors.ground,
    },
    retryText: { color: colors.accentText, fontWeight: "600", fontSize: texChatType.small },
  });
