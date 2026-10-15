import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Row } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import type { LeftBehind } from "./leftBehind";
import { leftBehindLine, leftBehindMore, leftBehindTitle } from "./leftBehind";

/**
 * In Settings › Storage after a move: which files over the file limit stayed
 * in the bucket the workspace moved from. Owner only (the view carries it to
 * nobody else), until they put it away.
 */
export function LeftBehindNotice({ left, onDismiss }: { left: LeftBehind | undefined; onDismiss?: () => void }) {
  if (left === undefined || left.count === 0) return null;
  const more = leftBehindMore(left);
  return (
    <Card testID="storage-left-behind" style={styles.card}>
      <Text variant="rowTitle">{leftBehindTitle(left)}</Text>
      <Text variant="rowSub" style={styles.line}>
        {leftBehindLine(left)}
      </Text>
      <View style={styles.list} testID="storage-left-behind-files">
        {left.keys.map((key) => (
          <Text key={key} variant="mono">
            {key}
          </Text>
        ))}
        {more === null ? null : <Text variant="meta">{more}</Text>}
      </View>
      {onDismiss === undefined ? null : (
        <Row style={styles.actions}>
          <Button label="Got it" onPress={onDismiss} testID="storage-left-behind-dismiss" />
        </Row>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 12 },
  line: { marginTop: 6 },
  list: { marginTop: 10, gap: 4 },
  actions: { marginTop: 14 },
});
