import { View } from "react-native";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import {
  describeLinkReach,
  describeOpenLink,
  describePersonalShare,
  describeTeamLink,
} from "../shares";
import { makeStyles } from "./styles";

/**
 * The long answers, for anybody who asks.
 *
 * These sentences used to be the dialog — a paragraph under every control —
 * and nobody read them there. Each is still true and still pinned by
 * `shareLink.test.ts`, so they are kept, one tap away in the header's menu,
 * instead of in the path of everyone who only wanted to copy a link.
 */
export function HowSharingWorks({
  entryKind,
  compact,
}: {
  entryKind: "file" | "folder";
  compact: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const text = [styles.meta, compact && styles.metaCompact];
  const rows: [string, string][] = [
    ["Sharing with a person", describePersonalShare()],
    ["The workspace link", describeTeamLink()],
    ["Anyone with the link", describeOpenLink(entryKind)],
  ];
  return (
    <View style={[styles.section, styles.confirm]} testID="share-help">
      {rows.map(([title, body]) => (
        <View key={title} style={{ gap: 2 }}>
          <Text style={[styles.name, compact && styles.nameCompact]}>{title}</Text>
          <Text variant="meta" style={text}>
            {body}
          </Text>
        </View>
      ))}
      <Text variant="meta" style={text} testID="share-link-reach">
        {describeLinkReach()}
      </Text>
    </View>
  );
}
