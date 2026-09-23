import { StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { agoShort, describeAgent, noteName, type ActiveAgent } from "./agentActivity";

/**
 * Who the foot line's "N agents active" is about, newest first.
 *
 * One row per agent: its colour, its name, and what it last did in words
 * ("Wrote launch-plan", "Read 4 notes"). Pressing a row opens the note that
 * event was about. The list is a glance, so no per-agent history. The full
 * record of what agents wrote is `activity.md`, one line above.
 */
export function AgentList({
  agents,
  now,
  onOpen,
}: {
  agents: readonly ActiveAgent[];
  /** Passed in, for the reason `ActivityList` takes one: every "4s" agrees. */
  now: number;
  onOpen: (path: string) => void;
}) {
  const styles = useThemedStyles(sheet);
  return (
    <View style={styles.list}>
      {agents.map((agent) => (
        <PressRow
          key={agent.id}
          accessibilityLabel={`${agent.name}. ${describeAgent(agent)}. Open ${noteName(agent.path)}`}
          onPress={() => onOpen(agent.path)}
          radius={radii.sm}
          style={styles.row}
          hoverStyle={styles.rowHover}
          testID={`agent-row-${agent.id}`}
        >
          <AgentSwatch color={agent.color} />
          <View style={styles.body}>
            <Text variant="tree" numberOfLines={1} style={styles.name}>
              {agent.name}
            </Text>
            <Text variant="treeMeta" numberOfLines={1} style={styles.meta}>
              {describeAgent(agent)}
            </Text>
          </View>
          <Text variant="treeMeta" numberOfLines={1} style={styles.when}>
            {agoShort(agent.at, now)}
          </Text>
        </PressRow>
      ))}
    </View>
  );
}

/**
 * An agent, drawn as a small rounded square in its colour.
 *
 * The same colour its caret carries in a note (both come from `colorFor` on
 * the same id), so the square in this list and the name on the text it wrote
 * are visibly the same agent. People are circles elsewhere in the console;
 * agents are squares.
 */
export function AgentSwatch({ color, size = 14 }: { color: string | null; size?: number }) {
  const styles = useThemedStyles(sheet);
  return (
    <View
      aria-hidden
      style={[
        styles.swatch,
        { width: size, height: size, borderRadius: Math.max(3, Math.round(size / 4)) },
        color === null ? styles.swatchUnknown : { backgroundColor: color },
      ]}
    />
  );
}

/** Up to three swatches, overlapped, for the foot line. */
export function AgentStack({ agents }: { agents: readonly ActiveAgent[] }) {
  const styles = useThemedStyles(sheet);
  return (
    <View style={styles.stack} aria-hidden>
      {agents.slice(0, 3).map((agent, index) => (
        <View key={agent.id} style={index === 0 ? null : styles.stacked}>
          <AgentSwatch color={agent.color} size={10} />
        </View>
      ))}
    </View>
  );
}

const sheet = (colors: Colors) =>
  StyleSheet.create({
    list: { paddingVertical: space.x1 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
    },
    rowHover: { backgroundColor: colors.chipFill },
    body: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    name: { color: colors.text2 },
    meta: { color: colors.chromeMuted },
    when: { color: colors.chromeMuted, flexShrink: 0 },
    swatch: { flexGrow: 0, flexShrink: 0 },
    swatchUnknown: { backgroundColor: colors.chromeMuted },
    stack: { flexDirection: "row", alignItems: "center" },
    stacked: { marginLeft: -3 },
  });
