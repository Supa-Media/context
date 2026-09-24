import { StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { describeAgentMark, type AgentMarkKind } from "./agentActivity";

/**
 * The mark on a row an agent read or wrote in the last few minutes.
 *
 * ## Why a square
 *
 * These rows already carry two round marks: the sync ring (`SyncMarkDot`) and
 * the petrol "new" disc. A third circle would be told apart by colour alone.
 * So this one differs in shape: a small rounded square, which is also how the
 * console draws an agent (people are circles, agents are squares).
 *
 *  - **read**: the outline only. The note was looked at, not changed.
 *  - **write**: filled. The note changed.
 *
 * In `text2` rather than the agent's own colour. A row names no agent, and in
 * a workspace with many of them one colour per row would be noise. Who it was
 * is in the list the foot line opens.
 */
export function AgentMark({ kind }: { kind: AgentMarkKind }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      role="img"
      accessibilityLabel={describeAgentMark(kind)}
      style={[styles.mark, kind === "write" ? styles.write : styles.read]}
      testID={`agent-mark-${kind}`}
    />
  );
}

/** A row's accessible name with its agent mark appended, as `withSyncMark` does. */
export function withAgentMark(label: string, kind: AgentMarkKind | null | undefined): string {
  return kind == null ? label : `${label}, ${describeAgentMark(kind)}`;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  mark: {
    width: 7,
    height: 7,
    borderRadius: 2,
    borderWidth: 1.5,
    flexGrow: 0,
    flexShrink: 0,
    borderColor: colors.text2,
  },
  read: {},
  write: { backgroundColor: colors.text2 },
});
