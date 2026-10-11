import { Pressable, View } from "react-native";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { useColors, useThemedStyles } from "../design/theme";
import { useChaosView } from "./ChaosContext";
import { ChaosFigure } from "./ChaosFigure";
import { chaosWord, scoreShown, shownScore, trendAgainst } from "./chaosModel";
import { makeChaosStyles } from "./styles";

/**
 * The phone's Home, at its foot: the figure, `Chaos 34 · crowded`, and a week
 * ago when known, on one quiet card that opens the panel as a sheet. Last on
 * the page and in muted type, so it is there for whoever scrolls to it and in
 * nobody's way otherwise. Nothing until the workspace has been scored.
 */
export function ChaosHomeLine() {
  const view = useChaosView();
  const colors = useColors();
  const styles = useThemedStyles(makeChaosStyles);
  if (view === undefined || !scoreShown(view.result)) return null;
  const result = view.result;
  const score = shownScore(result.score);
  const word = result.word ?? chaosWord(result.score);
  const trend = trendAgainst(result.score, result.weekAgo);
  return (
    <Pressable
      onPress={() => view.openPanel("sheet")}
      accessibilityRole="button"
      accessibilityLabel={`Chaos ${score} of 100, ${word}${trend === null ? "" : `, ${trend.label}`}. Show how it's scored`}
      style={({ pressed }) => [styles.homeLine, pressed ? styles.pressed : null]}
      testID="phone-home-chaos"
    >
      <ChaosFigure chaos={result.score} size={36} />
      <View style={styles.rowText}>
        <Text variant="treeTouch" numberOfLines={1}>
          {`Chaos ${score} · ${word}`}
        </Text>
        {result.weekAgo === null ? null : (
          <Text variant="treeMeta" style={styles.muted} numberOfLines={1}>
            {`a week ago ${shownScore(result.weekAgo)}${trend === null ? "" : ` ${trend.arrow}`}`}
          </Text>
        )}
      </View>
      <Icon name="chevronRight" size={14} color={colors.chromeMuted} />
    </Pressable>
  );
}
