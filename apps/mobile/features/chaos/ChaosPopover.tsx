import { Modal, Pressable, ScrollView, useWindowDimensions, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { layout } from "../design/tokens";
import { useThemedStyles } from "../design/theme";
import { useDismissOnOutside } from "../design/useDismissOnOutside";
import { makeStyles as makeExplorerStyles } from "../console/files/explorer/styles";
import { useChaosView } from "./ChaosContext";
import { ChaosPanel } from "./ChaosPanel";
import { scoreShown } from "./chaosModel";
import { makeChaosStyles } from "./styles";

/** What a press may land on without closing the foot's popover: the popover, and the line that toggles it. */
const INSIDE = ["explorer-chaos", "chaos-panel"] as const;

/**
 * The panel over the tree, opened by the foot's chaos line: the same floating
 * list the foot's other lines open (`ExplorerFootLists`' activity and agents
 * popovers), anchored above the line, closed by a press anywhere else or by
 * Escape.
 */
export function ChaosFootPopover({ lift }: { lift?: ViewStyle }) {
  const view = useChaosView();
  const explorer = useThemedStyles(makeExplorerStyles);
  const styles = useThemedStyles(makeChaosStyles);
  const open = view !== undefined && view.panel === "foot" && scoreShown(view.result);
  useDismissOnOutside(open, INSIDE, () => view?.closePanel());
  if (!open || !scoreShown(view.result)) return null;
  return (
    <View style={[explorer.activitySheet, lift]} testID="chaos-panel">
      <ScrollView style={styles.scroll}>
        <ChaosPanel result={view.result} figure={72} onOpen={view.open} />
      </ScrollView>
    </View>
  );
}

/**
 * The panel from anywhere but the tree's foot — a folder page's chip, the
 * phone's Home. A bottom sheet on a phone, as `RecentSheet` is; a floating
 * card in the middle of a wider window, where a sheet from the bottom edge
 * would be a long way from the chip that asked for it.
 */
export function ChaosSheet() {
  const view = useChaosView();
  const styles = useThemedStyles(makeChaosStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  if (view === undefined || view.panel !== "sheet" || !scoreShown(view.result)) return null;
  const wide = width >= layout.narrowBreakpoint;
  return (
    <Modal transparent animationType={wide ? "fade" : "slide"} visible onRequestClose={view.closePanel}>
      <Pressable
        style={[styles.scrim, wide && styles.scrimWide]}
        accessibilityLabel="Close chaos score"
        onPress={view.closePanel}
      >
        {/* Swallow presses inside the sheet so only the scrim dismisses it. */}
        <Pressable
          style={wide ? styles.sheetWide : [styles.sheet, { paddingBottom: insets.bottom + 12 }]}
          onPress={() => {}}
          accessibilityLabel="Chaos score"
          testID="chaos-panel"
        >
          {wide ? null : <View style={styles.grabber} aria-hidden />}
          <ScrollView style={styles.scroll}>
            <ChaosPanel result={view.result} figure={wide ? 96 : 112} onOpen={view.open} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
