import { StyleSheet } from "react-native";
import { PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Reveal } from "../design/components/Reveal";
import { Text } from "../design/components/Text";
import { radii } from "../design/tokens";
import { useColors, useThemedStyles } from "../design/theme";
import { makeStyles as makeExplorerStyles } from "../console/files/explorer/styles";
import { useChaosView } from "./ChaosContext";
import { ChaosFigure } from "./ChaosFigure";
import { chaosWord, scoreShown, shownScore, trendAgainst } from "./chaosModel";
import { makeChaosStyles } from "./styles";

/** The foot line's figure: a glyph, the size of the tree's own. */
const FIGURE = 18;

/**
 * One quiet line at the foot of the tree: a tiny figure, `Chaos 34`, its
 * word, and ↓ or ↑ against a week ago when that is known. Pressing it opens
 * the panel over the tree (`ChaosFootPopover`).
 *
 * One line, in the foot's own muted type and padding, eased in like the
 * agents line: the request was to see how organized things are, not to be
 * told. Nothing is drawn until the workspace has been scored.
 *
 * `onOpening` closes the foot's other popovers: only one is open at a time.
 */
export function ChaosFootLine({ onOpening }: { onOpening?: () => void }) {
  const view = useChaosView();
  const colors = useColors();
  const explorer = useThemedStyles(makeExplorerStyles);
  const styles = useThemedStyles(makeChaosStyles);
  const shown = view !== undefined && scoreShown(view.result);
  const result = shown ? view.result : null;
  const open = view?.panel === "foot";
  const trend = result === null ? null : trendAgainst(result.score, result.weekAgo);
  return (
    <Reveal open={shown}>
      {view === undefined || result === null || result.score === null ? null : (
        <PressRow
          accessibilityLabel={`Chaos ${shownScore(result.score)} of 100, ${result.word ?? chaosWord(result.score)}${
            trend === null ? "" : `, ${trend.label}`
          }. Show how it's scored`}
          onPress={() => {
            if (open) view.closePanel();
            else {
              onOpening?.();
              view.openPanel("foot");
            }
          }}
          ariaExpanded={open}
          ariaHasPopup="menu"
          radius={radii.sm}
          style={StyleSheet.flatten([explorer.foot, explorer.footPress])}
          hoverStyle={explorer.matchHover}
          testID="explorer-chaos"
        >
          <ChaosFigure chaos={result.score} size={FIGURE} />
          <Text variant="treeMeta" numberOfLines={1}>
            {`Chaos ${shownScore(result.score)}`}
          </Text>
          <Text variant="treeMeta" numberOfLines={1} style={[styles.footWord, explorer.footGrow]}>
            {result.word ?? chaosWord(result.score)}
            {trend === null ? "" : ` ${trend.arrow}`}
          </Text>
          <Icon name={open ? "chevronDown" : "chevronUp"} size={11} color={colors.chromeMuted} />
        </PressRow>
      )}
    </Reveal>
  );
}
