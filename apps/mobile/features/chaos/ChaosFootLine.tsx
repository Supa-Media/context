import { StyleSheet, View } from "react-native";
import { PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Reveal } from "../design/components/Reveal";
import { radii } from "../design/tokens";
import { useColors, useThemedStyles } from "../design/theme";
import { makeStyles as makeExplorerStyles } from "../console/files/explorer/styles";
import { useChaosView } from "./ChaosContext";
import { Tex } from "./Tex";
import { chaosWord, scoreShown, shownScore, trendAgainst } from "./chaosModel";

/** The foot's Tex: a little bigger than the tree's glyphs, so it reads as a figure. */
const FIGURE = 24;

/**
 * Tex alone at the foot of the tree, no words (Dev2's pick, 2026-10-13:
 * board 04 of "Showing the chaos score"): how tangled it is says how the
 * workspace is doing, and the score, its word and the week's trend are in its
 * label and in the panel a press opens over the tree (`ChaosFootPopover`).
 * Nothing is drawn until the workspace has been scored.
 *
 * `onOpening` closes the foot's other popovers: only one is open at a time.
 */
export function ChaosFootLine({ onOpening }: { onOpening?: () => void }) {
  const view = useChaosView();
  const colors = useColors();
  const explorer = useThemedStyles(makeExplorerStyles);
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
          <View style={explorer.footGrow}>
            <Tex chaos={result.score} size={FIGURE} />
          </View>
          <Icon name={open ? "chevronDown" : "chevronUp"} size={11} color={colors.chromeMuted} />
        </PressRow>
      )}
    </Reveal>
  );
}
