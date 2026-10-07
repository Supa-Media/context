import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { useColors, useScheme } from "../../../../design/theme";
import { darkMapColors, lightMapColors } from "../../../../design/tokens/colors";
import { PersonFace } from "../../../faces/PersonFace";

/**
 * Who, as the map draws them: a person is their face (`PersonFace` — a photo,
 * their emoji, or the Supa mark), an AI tool is the robot on an ink square.
 * The same shapes the canvas draws, so a line in the feed and a face on the
 * map read as the same one.
 */
export function ActorFace({ kind, name, size }: { kind: "person" | "agent"; name: string; size: number }) {
  if (kind === "person") return <PersonFace name={name} size={size} />;
  return <RobotFace size={size} />;
}

export function RobotFace({ size }: { size: number }) {
  const colors = useColors();
  const map = useScheme() === "dark" ? darkMapColors : lightMapColors;
  return (
    <View
      aria-hidden
      style={[styles.robot, { width: size, height: size, borderRadius: Math.round(size * 0.27), backgroundColor: map.ink }]}
      testID="robot-face"
    >
      <Icon name="robot" size={Math.round(size * 0.66)} color={colors.pageSurface} />
    </View>
  );
}

/**
 * Everybody working now, faces then robots, each pressable to follow them on
 * the map. Capped, with how many more after.
 */
export function FacePile({
  actors,
  size = 26,
  max = 10,
  following,
  onFollow,
}: {
  actors: ReadonlyArray<{ id: string; kind: "person" | "agent"; name: string }>;
  size?: number;
  max?: number;
  following?: string | null;
  onFollow?: (id: string) => void;
}) {
  const colors = useColors();
  const seen = new Set<string>();
  const unique = actors.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  const ordered = [...unique.filter((a) => a.kind === "person"), ...unique.filter((a) => a.kind === "agent")];
  const shown = ordered.slice(0, max);
  return (
    <View style={styles.pile} testID="map-face-pile">
      {shown.map((a) => (
        <Pressable
          key={a.id}
          onPress={onFollow === undefined ? undefined : () => onFollow(a.id)}
          disabled={onFollow === undefined}
          accessibilityRole="button"
          accessibilityLabel={following === a.id ? `Stop following ${a.name}` : `Follow ${a.name}`}
          style={[styles.pileItem, following === a.id && { borderColor: colors.accent }]}
        >
          <ActorFace kind={a.kind} name={a.name} size={size} />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  robot: { alignItems: "center", justifyContent: "center", flexShrink: 0 },
  pile: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
  pileItem: { borderRadius: 999, borderWidth: 2, borderColor: "transparent" },
});
