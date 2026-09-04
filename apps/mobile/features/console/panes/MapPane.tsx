import { StyleSheet, View } from "react-native";
import { AutoGrid } from "../../design/components/AutoGrid";
import { Dot } from "../../design/components/Dot";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { PaneHead } from "../ConsoleShell";
import { ConstellationMap } from "../map/ConstellationMap";
import type { ConsoleData, ConsoleStat } from "../types";

export function MapPane({ data }: { data: ConsoleData }) {
  const styles = useThemedStyles(makeStyles);
  const connected = data.contexts.length;

  return (
    <View>
      <PaneHead
        title="Your context"
        description="Everything you can read from — your brain, brains shared with you, and your workspaces — and which AI clients are connected to each. Solid edges are yours; dashed edges are access someone granted you."
        trailing={
          /*
            Absent, not zero, until the list has arrived — the same rule the
            stats below follow and the reason they are built that way. This
            pane is reachable while `loading` (its own rail entry), and "0
            connected" there is a count of a list nobody has fetched.
          */
          data.loading ? null : (
            <Pill tone="ok" leading={<Dot tone="ok" />}>
              {`${connected} connected`}
            </Pill>
          )
        }
      />
      <ConstellationMap graph={data.graph} />
      <AutoGrid
        items={data.stats}
        minItemWidth={148}
        gap={10}
        style={styles.meta}
        keyExtractor={(stat) => stat.label}
        renderItem={(stat) => <Stat stat={stat} />}
      />
    </View>
  );
}

/** `.stat` */
function Stat({ stat }: { stat: ConsoleStat }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.stat}>
      <Text variant="statValue">{stat.value}</Text>
      <Text variant="statLabel">{stat.label}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  /** `.mapmeta` — `repeat(auto-fit, minmax(148px, 1fr))`. */
  meta: {
    marginTop: 15,
  },
  stat: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.xl + 1,
    paddingVertical: 13,
    paddingHorizontal: 15,
    backgroundColor: colors.surface2,
  },
});
