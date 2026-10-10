import { View } from "react-native";
import { PressRow } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { radii } from "../design/tokens";
import { useThemedStyles } from "../design/theme";
import { baseName, displayName, parentPath } from "../console/files/paths";
import { ChaosFigure } from "./ChaosFigure";
import {
  biggestWins,
  chaosWord,
  folderHint,
  folderLabel,
  HOW_SCORED,
  itemsLabel,
  shownScore,
  trendAgainst,
  type ChaosScore,
} from "./chaosModel";
import { makeChaosStyles } from "./styles";

/**
 * What the score is and where it comes from: the figure, the number against
 * a week ago, the folders that would calm it most, the notes that run long,
 * and how it is scored.
 *
 * It reports, and nothing more. There is no "tidy now" here and no line
 * asking anybody to: the owner's rule is that people, or their agents, do the
 * tidying when they choose to, and a press on a folder or note only opens it.
 *
 * The body of both the foot's popover and the sheet (`ChaosPopover`).
 */
export function ChaosPanel({
  result,
  figure,
  onOpen,
}: {
  result: ChaosScore & { score: number };
  /** The figure's size: smaller in the tree's popover than in a sheet. */
  figure: number;
  onOpen: (path: string) => void;
}) {
  const styles = useThemedStyles(makeChaosStyles);
  const score = shownScore(result.score);
  const word = result.word ?? chaosWord(result.score);
  const trend = trendAgainst(result.score, result.weekAgo);
  const wins = biggestWins(result);
  return (
    <View style={styles.body} testID="chaos-panel-body">
      <View style={styles.head}>
        <ChaosFigure chaos={result.score} size={figure} testID="chaos-panel-figure" />
        <View style={styles.headText}>
          <Text variant="rowTitle" style={styles.score} testID="chaos-panel-score">
            {`Chaos ${score} of 100`}
          </Text>
          <Text variant="tree" style={styles.word}>
            {word}
          </Text>
          {result.weekAgo === null ? null : (
            <Text variant="treeMeta" style={styles.muted} testID="chaos-panel-week" accessibilityLabel={trend?.label}>
              {`a week ago ${shownScore(result.weekAgo)}${trend === null ? "" : ` ${trend.arrow}`}`}
            </Text>
          )}
        </View>
      </View>

      {wins.length === 0 ? null : (
        <View style={styles.section} testID="chaos-panel-wins">
          <Text variant="eyebrow" style={styles.sectionHead}>
            Biggest wins
          </Text>
          {wins.map((folder) => (
            <PressRow
              key={folder.folder}
              accessibilityLabel={`Open ${folderLabel(folder.folder)}, ${itemsLabel(folder.items)}`}
              onPress={() => onOpen(folder.folder)}
              radius={radii.sm}
              style={styles.row}
              hoverStyle={styles.rowHover}
              testID={`chaos-win-${folder.folder}`}
            >
              <View style={styles.rowText}>
                <Text variant="tree" numberOfLines={1}>
                  {folderLabel(folder.folder)}
                </Text>
                <Text variant="treeMeta" numberOfLines={2} style={styles.muted}>
                  {folderHint(folder.items, folder.chaos)}
                </Text>
              </View>
              <Text variant="treeMeta" style={styles.rowCount}>
                {itemsLabel(folder.items)}
              </Text>
            </PressRow>
          ))}
        </View>
      )}

      {result.longNotes.length === 0 ? null : (
        <View style={styles.section} testID="chaos-panel-long">
          <Text variant="eyebrow" style={styles.sectionHead}>
            Long notes
          </Text>
          {result.longNotes.map((note) => (
            <PressRow
              key={note.path}
              accessibilityLabel={`Open ${displayName(baseName(note.path))}, ${note.lines} lines`}
              onPress={() => onOpen(note.path)}
              radius={radii.sm}
              style={styles.row}
              hoverStyle={styles.rowHover}
              testID={`chaos-long-${note.path}`}
            >
              <View style={styles.rowText}>
                <Text variant="tree" numberOfLines={1}>
                  {displayName(baseName(note.path))}
                </Text>
                <Text variant="treeMeta" numberOfLines={1} style={styles.muted}>
                  {folderLabel(parentPath(note.path))}
                </Text>
              </View>
              <Text variant="treeMeta" style={styles.rowCount}>
                {`${note.lines.toLocaleString("en-US")} lines`}
              </Text>
            </PressRow>
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Text variant="eyebrow" style={styles.sectionHead}>
          How it’s scored
        </Text>
        <Text variant="treeMeta" style={styles.how} testID="chaos-panel-how">
          {HOW_SCORED}
        </Text>
      </View>
    </View>
  );
}
