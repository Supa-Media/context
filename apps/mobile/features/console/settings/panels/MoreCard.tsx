import { PressRow } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { StyleSheet } from "react-native";
import type { SettingsSectionKey } from "../sections";

/**
 * An optional page reached from here rather than listed: meetings on this
 * Mac. The AI key row was removed (owner, 2026-10-10). Absent `onSelect` (the landing-page demo)
 * draws nothing, since there is nowhere to go.
 */
export function MoreCard({ onSelect }: { onSelect?: (key: SettingsSectionKey) => void }) {
  if (onSelect === undefined) return null;
  return (
    <>
      <Text variant="eyebrow" style={styles.head}>
        More
      </Text>
      <Card>
        <MoreRow
          title="Meetings on your Mac"
          sub="Record calls into notes"
          onPress={() => onSelect("meetings")}
          testID="settings-more-meetings"
        />
      </Card>
    </>
  );
}

function MoreRow({
  title,
  sub,
  onPress,
  testID,
}: {
  title: string;
  sub: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <PressRow onPress={onPress} accessibilityLabel={`${title}. ${sub}`} testID={testID}>
      <Row>
        <Grow>
          <Text variant="rowTitle">{title}</Text>
          <Text variant="rowSub">{sub}</Text>
        </Grow>
        <Icon name="chevronRight" size={16} />
      </Row>
    </PressRow>
  );
}

const styles = StyleSheet.create({
  head: { marginTop: space.x5, marginBottom: space.x2 },
});
