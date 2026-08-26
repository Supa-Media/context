import { StyleSheet, View } from "react-native";
import { AutoGrid } from "../../design/components/AutoGrid";
import { Dot } from "../../design/components/Dot";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { colors, radii } from "../../design/tokens";
import { PaneHead } from "../ConsoleShell";
import { ConstellationMap } from "../map/ConstellationMap";
import type { ConsoleData, ConsoleStat } from "../types";

export function MapPane({ data }: { data: ConsoleData }) {
  const connected = data.contexts.length;

  return (
    <View>
      <PaneHead
        title="Reachable contexts"
        description="Every context you can read from, and which AI clients are connected to each. Solid edges are yours; dashed edges are access someone granted you."
        trailing={
          <Pill tone="ok" leading={<Dot tone="ok" />}>
            {`${connected} connected`}
          </Pill>
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
  return (
    <View style={styles.stat}>
      <Text variant="statValue">{stat.value}</Text>
      <Text variant="statLabel">{stat.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
