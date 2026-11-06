import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../../design/components/Icon";
import { Dot } from "../../design/components/Dot";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { ASIDE_TABS, type AsideTab } from "./tabs";

const ICONS: Record<AsideTab, IconName> = {
  activity: "people",
  note: "file",
  meetings: "calendar",
  approvals: "checkCircle",
};

/**
 * The right panel folded (Dev2, 2026-11-05: "i would also like the panel to
 * be collapsable"): a slim strip down the right edge with one button per tab.
 * A press on one unfolds the panel on that tab; the top button unfolds it as
 * it was. The marks the tab row carries (a meeting recording) stay here too,
 * so folding it never hides something running.
 */
export function AsideStrip({
  tabs,
  showing,
  recording,
  onUnfold,
}: {
  tabs: readonly AsideTab[];
  showing: AsideTab;
  recording: boolean;
  onUnfold: (tab: AsideTab | null) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.strip} testID="aside-strip">
      <Pressable
        onPress={() => onUnfold(null)}
        accessibilityRole="button"
        accessibilityLabel="Unfold the panel"
        style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.button, hovered && styles.hover]}
        testID="aside-unfold"
      >
        <Icon name="chevronLeft" size={16} color={colors.text2} />
      </Pressable>
      <View style={styles.rule} />
      {ASIDE_TABS.filter((tab) => tabs.includes(tab.key)).map((tab) => (
        <Pressable
          key={tab.key}
          onPress={() => onUnfold(tab.key)}
          accessibilityRole="button"
          accessibilityLabel={tab.key === "meetings" && recording ? `${tab.label}, recording` : tab.label}
          style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.button, tab.key === showing && styles.current, hovered && styles.hover]}
          testID={`aside-strip-${tab.key}`}
        >
          <Icon name={ICONS[tab.key]} size={16} color={tab.key === showing ? colors.text : colors.text2} />
          {tab.key === "meetings" && recording ? (
            <View style={styles.dot}>
              <Dot tone="crit" />
            </View>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    strip: { flex: 1, alignItems: "center", gap: space.x1, paddingTop: space.x2 },
    button: { width: 36, height: 36, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
    current: { backgroundColor: colors.chrome },
    hover: { backgroundColor: colors.chrome },
    rule: { width: 20, height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space.x1 },
    dot: { position: "absolute", top: 6, right: 6 },
  });
